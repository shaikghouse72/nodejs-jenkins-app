#!/bin/bash
set -euo pipefail
 
COMMIT_MESSAGE="${1:-Update application files}"
 
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "ERROR: Current directory is not a Git repository."
    exit 1
fi
 
CURRENT_BRANCH=$(git branch --show-current)
 
if [ "$CURRENT_BRANCH" != "master" ]; then
    echo "ERROR: Current branch is '$CURRENT_BRANCH', not 'master'."
    exit 1
fi
 
echo "Repository: $(git rev-parse --show-toplevel)"
echo "Branch: $CURRENT_BRANCH"
echo
git status --short
 
if [ -z "$(git status --porcelain)" ]; then
    echo "No local changes found."
    exit 0
fi
 
echo
read -r -p "Commit ALL displayed changes and push to master? [y/N]: " CONFIRM
 
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Cancelled. Nothing was committed or pushed."
    exit 0
fi
 
echo "Staging changes..."
git add -A
 
echo "Committing changes..."
git commit -m "$COMMIT_MESSAGE"
 
echo "Synchronizing with remote master..."
git pull --rebase origin master
 
echo "Pushing to remote master..."
git push origin master
 
echo
echo "SUCCESS: Changes pushed to origin/master."
git log -1 --oneline
