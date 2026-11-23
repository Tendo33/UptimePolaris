package polaris

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// 两个进程各有自己的连接池，进程内的锁帮不上忙；写事务必须在 BEGIN 阶段
// 取得写锁，否则并发读-判-写会同时通过。
// Two processes each own a connection pool, so an in-process lock cannot help.
// A write transaction has to hold the write lock from BEGIN onward, or
// concurrent read-check-write passes twice.
func TestSQLiteWriteTransactionTakesTheLockAtBegin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock.db")
	first := openSQLiteProbe(t, path)
	second := openSQLiteProbe(t, path)
	if _, err := first.Exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := first.Exec(`INSERT INTO t(id,v) VALUES(1,'start')`); err != nil {
		t.Fatal(err)
	}

	tx, err := first.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE t SET v='first' WHERE id=1`); err != nil {
		t.Fatal(err)
	}

	// 第二个写者必须在 BEGIN 就被挡住，而不是读到旧值后才在写入时冲突。
	// The second writer must be blocked at BEGIN, not after reading a stale row.
	secondTx, err := second.Begin()
	if err == nil {
		secondTx.Rollback()
		t.Fatal("a second write transaction began while the first held the lock")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "locked") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// 打开一个模拟独立进程的连接池，使用与 openStore 相同的 DSN 选项。
// Open a pool that stands in for a separate process, using the same DSN options.
func openSQLiteProbe(t *testing.T, path string) *sql.DB {
	t.Helper()
	dsn := path + "?_txlock=immediate&_pragma=busy_timeout(50)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if err = db.PingContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	return db
}
