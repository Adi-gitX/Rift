#!/bin/bash
set -e

# Run filter-repo to remove .claude completely from history
git filter-repo --path .claude --invert-paths --force

# Re-add the remote origin
git remote add origin git@github.com:Adi-gitX/Rift.git

# Force push all branches to the remote
git push origin --force --all
