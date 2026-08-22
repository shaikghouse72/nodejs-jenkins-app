#!/bin/bash

set -e

REPO="/opt/nodejs-jenkins-app"
BRANCH="master"

cd "$REPO"

echo "======================================"
echo "Repository: $REPO"
echo "Branch: $BRANCH"
echo "======================================"

echo "Checking for changes..."

if [[ -z "$(git status --porcelain)" ]]; then
    echo "No changes to commit."
    exit 0
fi

git status --short

echo "Staging all changes..."
git add -A

echo "Committing changes..."
git commit -m "Update application files"

echo "Synchronizing with remote..."
git pull --rebase origin "$BRANCH"

echo "Pushing to remote..."
git push origin "$BRANCH"

echo ""
echo "======================================"
echo "SUCCESS: Changes pushed to origin/$BRANCH"
echo "======================================"

git log -1 --oneline
