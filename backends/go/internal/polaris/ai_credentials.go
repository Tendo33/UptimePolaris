package polaris

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const aiCredentialDomain = "uptime-polaris-ai-credentials-v1"

func (a *App) aiKey(ctx context.Context, create bool) ([]byte, error) {
	path := a.config.AICredentialKeyFile
	auto := path == "" && !a.store.postgres
	if auto {
		path = filepath.Join(a.config.DataDir, "ai-credential.key")
	}
	if path == "" {
		return nil, failure("ai_key_material_unavailable", 503)
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) && auto && create {
		channels, e := a.store.list(ctx, "ai_channel")
		if e != nil || len(channels) != 0 {
			return nil, failure("ai_key_material_unavailable", 503)
		}
		for _, kind := range []string{"subscription_config", "subscription_previous", "subscription_preview", "subscription_cache"} {
			rows, e := a.store.list(ctx, kind)
			if e != nil {
				return nil, failure("ai_key_material_unavailable", 503)
			}
			for _, row := range rows {
				if str(row, "ciphertext") != "" {
					return nil, failure("ai_key_material_unavailable", 503)
				}
			}
		}
		file, e := os.CreateTemp(a.config.DataDir, ".ai-key-*")
		if e != nil {
			return nil, failure("ai_key_material_unavailable", 503)
		}
		defer os.Remove(file.Name())
		defer file.Close()
		if e = protectAIKey(file.Name()); e != nil {
			return nil, failure("ai_key_material_unavailable", 503)
		}
		material := make([]byte, 32)
		if _, e = rand.Read(material); e == nil {
			_, e = file.Write(material)
		}
		if e == nil {
			e = file.Sync()
		}
		if e == nil {
			e = file.Close()
		}
		if e == nil {
			e = publishAIKey(file.Name(), path)
		}
		if e != nil && !errors.Is(e, os.ErrExist) {
			return nil, failure("ai_key_material_unavailable", 503)
		}
		info, err = os.Lstat(path)
	}
	if err != nil || !info.Mode().IsRegular() || !aiKeyPermissions(info, path) {
		return nil, failure("ai_key_material_unavailable", 503)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, failure("ai_key_material_unavailable", 503)
	}
	defer file.Close()
	material, err := io.ReadAll(io.LimitReader(file, 33))
	if err != nil || len(material) != 32 {
		return nil, failure("ai_key_material_unavailable", 503)
	}
	return material, nil
}

func aiCipher(material []byte) (cipher.AEAD, error) {
	key, err := hkdf.Key(sha256.New, material, []byte(aiCredentialDomain), "channel-api-key", 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func encryptAICredential(value, id string, material []byte) (string, error) {
	aead, err := aiCipher(material)
	if err != nil {
		return "", failure("ai_key_material_unavailable", 503)
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", failure("ai_key_material_unavailable", 503)
	}
	encrypted := aead.Seal(nil, nonce, []byte(value), []byte(aiCredentialDomain+":"+id))
	return "v1." + base64.StdEncoding.EncodeToString(nonce) + "." + base64.StdEncoding.EncodeToString(encrypted), nil
}

func (a *App) decryptAICredential(ctx context.Context, channel Object) (string, error) {
	material, err := a.aiKey(ctx, false)
	if err != nil {
		return "", err
	}
	aead, err := aiCipher(material)
	if err != nil {
		return "", failure("ai_key_material_unavailable", 503)
	}
	parts := strings.Split(str(channel, "credential_ciphertext"), ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return "", failure("ai_credential_decryption_failed", 503)
	}
	nonce, e1 := base64.StdEncoding.DecodeString(parts[1])
	encrypted, e2 := base64.StdEncoding.DecodeString(parts[2])
	if e1 != nil || e2 != nil || len(nonce) != aead.NonceSize() {
		return "", failure("ai_credential_decryption_failed", 503)
	}
	plain, err := aead.Open(nil, nonce, encrypted, []byte(aiCredentialDomain+":"+str(channel, "id")))
	if err != nil {
		return "", failure("ai_credential_decryption_failed", 503)
	}
	return string(plain), nil
}
