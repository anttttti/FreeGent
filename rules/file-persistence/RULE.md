---
name: file-persistence
description: Files modified locally must be persisted back to their source. Covers WebDAV/OwnCloud uploads and git push after committing changes to a cloned repository.
trigger: download, upload, WebDAV, OwnCloud, git clone, git push, save file, modified file, PUT, commit changes
roles: coder, researcher, director, agent
---

## Files you download must be uploaded back after modification

Downloading a file and saving a modified copy locally is not enough — the evaluator or downstream system reads the **source**, not your local workspace. You must persist changes back.

### WebDAV / OwnCloud

After modifying a file that came from WebDAV, PUT it back:

```bash
# Upload a local file to WebDAV
curl -u USER:PASS -T local/path/to/file.xlsx 'http://HOST/remote.php/webdav/FOLDER/file.xlsx'

# Verify the upload succeeded (HTTP 201 Created or 204 No Content = success)
curl -u USER:PASS -I 'http://HOST/remote.php/webdav/FOLDER/file.xlsx'
```

Do this **before** declaring the task complete. A file that exists only in `/workspace` will not be seen by any other system.

### Git repositories

When you clone a repository and make changes, commit and push them to the remote — local commits are invisible to the server:

```bash
cd /workspace/repo-name
git add -A
git commit -m "type: short summary"
git push
```

If the remote requires credentials, set them via the clone URL:
```bash
git clone http://USER:PASSWORD@HOST/path/repo.git
```

Then push with the same URL already embedded in `origin`.

### Rules

- **After any `write_file` to a path you downloaded from WebDAV**: follow with a `curl -T` PUT to the original WebDAV URL.
- **After fixing or adding code in a cloned repo**: `git add`, `git commit`, `git push` before declaring done.
- **Verify the upload**: check the HTTP status code or run a PROPFIND/HEAD to confirm the file exists at the remote path.
- **Do not assume the task is complete** until you have confirmed the output exists at the location the evaluator or user will check.
