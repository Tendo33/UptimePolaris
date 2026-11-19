//go:build !windows

package polaris

import (
	"os"
	"path/filepath"
)

func protectAIKey(path string) error                   { return os.Chmod(path, 0600) }
func aiKeyPermissions(info os.FileInfo, _ string) bool { return info.Mode().Perm()&0077 == 0 }

func publishAIKey(source, destination string) error {
	if err := os.Link(source, destination); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(destination))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
