package localfixture

import (
	"context"
	"errors"
	"os"
	"sync"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
	fixture "github.com/fukamu/notes/backend/internal/localfixture"
)

const objectDeleteQuarantinePrefix = ".delete-"

// AnchoredObjectDeletion keeps the validated fixture root and object directory
// open for the composition lifetime. A later pathname or symlink replacement
// therefore cannot redirect a private-object deletion outside that fixture.
type AnchoredObjectDeletion struct {
	mutex      sync.Mutex
	layout     Layout
	identities deletionDirectoryIdentities
	parent     *os.Root
	objects    *os.Root
	closed     bool
}

func NewAnchoredObjectDeletion(layout Layout) (*AnchoredObjectDeletion, error) {
	opened, err := OpenLayout(layout.RootDirectory)
	if err != nil || opened != layout {
		return nil, ErrLayoutOperation
	}
	identities, err := captureDeletionDirectoryIdentities(layout)
	if err != nil {
		return nil, ErrLayoutOperation
	}
	parent, err := os.OpenRoot(layout.RootDirectory)
	if err != nil || !rootHasDirectoryIdentity(parent, identities.root) {
		if parent != nil {
			_ = parent.Close()
		}
		return nil, ErrLayoutOperation
	}
	objects, err := parent.OpenRoot(fixture.ObjectDirectoryName)
	if err != nil || !rootHasDirectoryIdentity(objects, identities.objects) {
		if objects != nil {
			_ = objects.Close()
		}
		_ = parent.Close()
		return nil, ErrLayoutOperation
	}
	deletion := &AnchoredObjectDeletion{
		layout: layout, identities: identities, parent: parent, objects: objects,
	}
	if !deletion.bindingValid() {
		_ = deletion.Close()
		return nil, ErrLayoutOperation
	}
	return deletion, nil
}

func (deletion *AnchoredObjectDeletion) Delete(
	ctx context.Context,
	objectKey encryptedobject.ObjectKey,
) (encryptedobject.DeleteResult, error) {
	if deletion == nil || ctx == nil {
		return "", ErrLayoutOperation
	}
	if _, err := encryptedobject.ParseObjectKey(string(objectKey)); err != nil {
		return "", ErrLayoutOperation
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	deletion.mutex.Lock()
	defer deletion.mutex.Unlock()
	if deletion.closed || !deletion.bindingValid() {
		return "", ErrLayoutOperation
	}
	name := string(objectKey)
	quarantine := objectDeleteQuarantinePrefix + name
	if _, err := deletion.objects.Lstat(quarantine); err == nil {
		if _, originalErr := deletion.objects.Lstat(name); originalErr == nil {
			return "", ErrLayoutOperation
		} else if !errors.Is(originalErr, os.ErrNotExist) {
			return "", ErrLayoutOperation
		}
		if err := removeQuarantinedPrivateFile(deletion.objects, quarantine, nil); err != nil {
			return "", err
		}
		return encryptedobject.DeleteDeleted, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", ErrLayoutOperation
	}
	info, err := deletion.objects.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return encryptedobject.DeleteNotFound, nil
	}
	identity, identityErr := identityForPrivateFile(info)
	if err != nil || identityErr != nil {
		return "", ErrLayoutOperation
	}
	if err := deletion.objects.Rename(name, quarantine); err != nil {
		return "", ErrLayoutOperation
	}
	if err := removeQuarantinedPrivateFile(deletion.objects, quarantine, &identity); err != nil {
		_ = deletion.objects.Rename(quarantine, name)
		return "", err
	}
	return encryptedobject.DeleteDeleted, nil
}

func (deletion *AnchoredObjectDeletion) Close() error {
	if deletion == nil {
		return ErrLayoutOperation
	}
	deletion.mutex.Lock()
	defer deletion.mutex.Unlock()
	if deletion.closed {
		return nil
	}
	deletion.closed = true
	objectsErr := deletion.objects.Close()
	parentErr := deletion.parent.Close()
	if objectsErr != nil || parentErr != nil {
		return ErrLayoutOperation
	}
	return nil
}

func (deletion *AnchoredObjectDeletion) bindingValid() bool {
	if deletion == nil || deletion.parent == nil || deletion.objects == nil ||
		!rootHasDirectoryIdentity(deletion.parent, deletion.identities.root) ||
		!rootHasDirectoryIdentity(deletion.objects, deletion.identities.objects) {
		return false
	}
	rootInfo, rootErr := os.Lstat(deletion.layout.RootDirectory)
	rootIdentity, rootIdentityErr := identityForPrivateDirectory(rootInfo)
	childInfo, childErr := deletion.parent.Lstat(fixture.ObjectDirectoryName)
	childIdentity, childIdentityErr := identityForPrivateDirectory(childInfo)
	return rootErr == nil && rootIdentityErr == nil && rootIdentity == deletion.identities.root &&
		childErr == nil && childIdentityErr == nil && childIdentity == deletion.identities.objects
}

func removeQuarantinedPrivateFile(
	root *os.Root,
	name string,
	expected *fileIdentity,
) error {
	info, err := root.Lstat(name)
	identity, identityErr := identityForPrivateFile(info)
	if err != nil || identityErr != nil || (expected != nil && identity != *expected) {
		return ErrLayoutOperation
	}
	if err := root.Remove(name); err != nil {
		return ErrLayoutOperation
	}
	return syncOpenedRoot(root)
}

var _ encryptedobject.PrivateObjectDeletePort = (*AnchoredObjectDeletion)(nil)
