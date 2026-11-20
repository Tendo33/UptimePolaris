//go:build !windows

package updates

import (
	"golang.org/x/sys/unix"
	"os"
)

func replaceFile(from, to string) error { return os.Rename(from, to) }

func acquireLock(path string) (func(), error) {
	f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); e != nil {
		f.Close()
		return nil, e
	}
	return func() { f.Close() }, nil
}
