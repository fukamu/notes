package postgres

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	fixture "github.com/fukamu/notes/backend/internal/localfixture"
	"github.com/jackc/pgx/v5"
)

var ErrLocalFixtureRuntimeLease = errors.New("local fixture runtime lease unavailable")

const (
	localFixtureLeaseNamespace int32 = 0x46554b41 // FUKA
	localFixtureLeaseKey       int32 = 0x4d554e4f // MUNO
)

// LocalFixtureRuntimeLease combines a host-local flock with a PostgreSQL
// advisory lock. The host lock is retained even if PostgreSQL restarts or the
// keeper session is killed, so a cooperating replacement runtime or
// prepare-e2e process cannot overlap filesystem or database mutation by the
// original process. The local fixture assumes those processes do not rename or
// unlink the same-UID lock namespace; a same-UID adversary could mutate the
// disposable fixture directly and is outside this development-only boundary.
type LocalFixtureRuntimeLease struct {
	mutex      sync.Mutex
	hostLock   *localFixtureHostLock
	connection *pgx.Conn
	backendPID uint32
}

type localFixtureHostLock struct {
	directory         string
	root              *os.Root
	file              *os.File
	directoryIdentity syscall.Stat_t
	fileIdentity      syscall.Stat_t
}

func AcquireLocalFixtureRuntimeLease(
	ctx context.Context,
	databaseURL string,
) (*LocalFixtureRuntimeLease, error) {
	if ctx == nil || fixture.ValidateDatabaseURL(databaseURL) != nil {
		return nil, ErrLocalFixtureRuntimeLease
	}
	hostLock, err := acquireLocalFixtureHostLock()
	if err != nil {
		return nil, ErrLocalFixtureRuntimeLease
	}
	releaseHost := func() {
		_ = hostLock.close()
	}
	connection, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		releaseHost()
		return nil, ErrLocalFixtureRuntimeLease
	}
	var database string
	var backendPID uint32
	var acquired bool
	err = connection.QueryRow(ctx, `SELECT current_database(), pg_backend_pid(), pg_try_advisory_lock($1, $2)`,
		localFixtureLeaseNamespace, localFixtureLeaseKey,
	).Scan(&database, &backendPID, &acquired)
	if err != nil || database != fixture.DisposableDatabaseName || backendPID == 0 || !acquired {
		_ = connection.Close(context.Background())
		releaseHost()
		return nil, ErrLocalFixtureRuntimeLease
	}
	return &LocalFixtureRuntimeLease{
		hostLock: hostLock, connection: connection, backendPID: backendPID,
	}, nil
}

func acquireLocalFixtureHostLock() (*localFixtureHostLock, error) {
	directory := filepath.Join("/tmp", fmt.Sprintf("fukamu-notes-%d", os.Getuid()))
	return acquireLocalFixtureHostLockAt(directory, nil)
}

func acquireLocalFixtureHostLockAt(
	directory string,
	afterInitialInspect func(),
) (*localFixtureHostLock, error) {
	if err := os.Mkdir(directory, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, ErrLocalFixtureRuntimeLease
	}
	info, err := os.Lstat(directory)
	if err != nil || !privateLeaseDirectory(info) {
		return nil, ErrLocalFixtureRuntimeLease
	}
	directoryIdentity, ok := fileIdentity(info)
	if !ok {
		return nil, ErrLocalFixtureRuntimeLease
	}
	if afterInitialInspect != nil {
		afterInitialInspect()
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, ErrLocalFixtureRuntimeLease
	}
	releaseRoot := func() { _ = root.Close() }
	rootInfo, err := root.Stat(".")
	if err != nil || !privateLeaseDirectory(rootInfo) || !sameFileIdentity(rootInfo, directoryIdentity) {
		releaseRoot()
		return nil, ErrLocalFixtureRuntimeLease
	}
	name := fixture.DisposableDatabaseName + ".runtime.lock"
	file, err := root.OpenFile(
		name,
		os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW,
		0o600,
	)
	if err != nil {
		releaseRoot()
		return nil, ErrLocalFixtureRuntimeLease
	}
	fileInfo, fileErr := file.Stat()
	pathFileInfo, pathFileErr := root.Lstat(name)
	lockIdentity, lockIdentityOK := fileIdentity(fileInfo)
	if fileErr != nil || pathFileErr != nil || !lockIdentityOK ||
		!privateLeaseFile(fileInfo) || !privateLeaseFile(pathFileInfo) ||
		!sameFileIdentity(pathFileInfo, lockIdentity) {
		_ = file.Close()
		releaseRoot()
		return nil, ErrLocalFixtureRuntimeLease
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		releaseRoot()
		return nil, ErrLocalFixtureRuntimeLease
	}
	lock := &localFixtureHostLock{
		directory: directory, root: root, file: file,
		directoryIdentity: directoryIdentity, fileIdentity: lockIdentity,
	}
	if !lock.check() {
		_ = lock.close()
		return nil, ErrLocalFixtureRuntimeLease
	}
	return lock, nil
}

func privateLeaseDirectory(info os.FileInfo) bool {
	if info == nil || !info.IsDir() || info.Mode().Perm() != 0o700 ||
		info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid())
}

func privateLeaseFile(info os.FileInfo) bool {
	if info == nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 ||
		info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid()) && stat.Nlink == 1
}

func fileIdentity(info os.FileInfo) (syscall.Stat_t, bool) {
	if info == nil {
		return syscall.Stat_t{}, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return syscall.Stat_t{}, false
	}
	return *stat, true
}

func sameFileIdentity(info os.FileInfo, expected syscall.Stat_t) bool {
	actual, ok := fileIdentity(info)
	return ok && actual.Dev == expected.Dev && actual.Ino == expected.Ino
}

func (lock *localFixtureHostLock) check() bool {
	if lock == nil || lock.root == nil || lock.file == nil || lock.directory == "" {
		return false
	}
	rootInfo, rootErr := lock.root.Stat(".")
	pathInfo, pathErr := os.Lstat(lock.directory)
	fileInfo, fileErr := lock.file.Stat()
	pathFileInfo, pathFileErr := lock.root.Lstat(fixture.DisposableDatabaseName + ".runtime.lock")
	return rootErr == nil && pathErr == nil && fileErr == nil && pathFileErr == nil &&
		privateLeaseDirectory(rootInfo) && privateLeaseDirectory(pathInfo) &&
		sameFileIdentity(rootInfo, lock.directoryIdentity) &&
		sameFileIdentity(pathInfo, lock.directoryIdentity) &&
		privateLeaseFile(fileInfo) && privateLeaseFile(pathFileInfo) &&
		sameFileIdentity(fileInfo, lock.fileIdentity) &&
		sameFileIdentity(pathFileInfo, lock.fileIdentity)
}

func (lock *localFixtureHostLock) close() error {
	if lock == nil || lock.file == nil || lock.root == nil {
		return ErrLocalFixtureRuntimeLease
	}
	file := lock.file
	root := lock.root
	lock.file = nil
	lock.root = nil
	unlockErr := syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	fileErr := file.Close()
	rootErr := root.Close()
	if unlockErr != nil || fileErr != nil || rootErr != nil {
		return ErrLocalFixtureRuntimeLease
	}
	return nil
}

// Check proves that the dedicated keeper session is still connected to the
// exact disposable database and still owns its advisory lock. The host flock
// remains held when this check fails.
func (lease *LocalFixtureRuntimeLease) Check(ctx context.Context) error {
	if lease == nil || ctx == nil {
		return ErrLocalFixtureRuntimeLease
	}
	lease.mutex.Lock()
	defer lease.mutex.Unlock()
	if lease.connection == nil || lease.hostLock == nil || lease.backendPID == 0 {
		return ErrLocalFixtureRuntimeLease
	}
	if !lease.hostLock.check() {
		return ErrLocalFixtureRuntimeLease
	}
	var database string
	var backendPID uint32
	var held bool
	err := lease.connection.QueryRow(ctx, `SELECT current_database(), pg_backend_pid(), EXISTS (
		SELECT 1 FROM pg_locks
		 WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
		   AND classid = $1::oid AND objid = $2::oid AND objsubid = 2
	)`, localFixtureLeaseNamespace, localFixtureLeaseKey).Scan(&database, &backendPID, &held)
	if err != nil || database != fixture.DisposableDatabaseName || backendPID != lease.backendPID || !held {
		return ErrLocalFixtureRuntimeLease
	}
	return nil
}

func (lease *LocalFixtureRuntimeLease) Close() error {
	if lease == nil {
		return ErrLocalFixtureRuntimeLease
	}
	lease.mutex.Lock()
	defer lease.mutex.Unlock()
	if lease.connection == nil || lease.hostLock == nil {
		return ErrLocalFixtureRuntimeLease
	}
	connection := lease.connection
	hostLock := lease.hostLock
	lease.connection = nil
	lease.hostLock = nil
	lease.backendPID = 0
	cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var released bool
	unlockErr := connection.QueryRow(cleanup, `SELECT pg_advisory_unlock($1, $2)`,
		localFixtureLeaseNamespace, localFixtureLeaseKey,
	).Scan(&released)
	closeErr := connection.Close(cleanup)
	hostCloseErr := hostLock.close()
	if unlockErr != nil || !released || closeErr != nil || hostCloseErr != nil {
		return ErrLocalFixtureRuntimeLease
	}
	return nil
}
