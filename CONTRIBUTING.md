# Contributing to Redbus 

We're glad you're interested in contributing to Redbus. This document outlines the standards we follow so we can keep things predictable, fast, and organized.

## 1. Branching Strategy / Git Flow
We keep our git strategy simple. 
- **`main`**: Must ALWAYS be deployable and stable. Direct commits to main are discouraged for non-core team members.
- **Branches**: Create a new branch off `main` for your work. Use the following prefixes:
  - `feature/your-feature-name` (for new stuff)
  - `bugfix/issue-description` (for fixing shit that broke)
  - `chore/update-deps` (for maintenance, text changes, docs)

**Example Workflow:**
```bash
git checkout main
git pull
git checkout -b feature/cool-new-gui
# do your work...
git add .
git commit -m "feat: added a cool new GUI"
git push origin feature/cool-new-gui
```

## 2. Commit Message Convention
Use **Conventional Commits** so we have a clean history. 
Format: `<type>: <description>`
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation updates
- `style:` for formatting/styling changes without logic change
- `refactor:` for code changes that neither fix a bug nor add a feature

## 3. The Changelog (Important!)
We maintain a live changelog in the frontend to tell users what changed. 
If your PR introduces a new feature, improvement, or a noticeable bug fix:
1. Open `frontend/src/data/changelog.ts`.
2. Determine if it's a `patch`, `minor`, or `major` update. Add or update the latest block with your specific change under `changes`. 
3. This will immediately display your change on the UI.

## 4. Submitting a Pull Request
- Don't merge your own code alone if you want proper reviews.
- Wait for CI/CD or another developer's review.
- Fill out the provided PR template.

## 5. Development Code Style (Frontend)
- **Brutalism:** Minimalist, no-bullshit, functional over fancy but with aggressive style (Red/Black colors, Monospace fonts, Uppercase text).
- **React/Vite:** Keep components pure. Don't add heavy UI libraries unless absolutely necessary. We use raw TailwindCSS and simple functional components. 

## Welcome Aboard
Redbus is an engine for getting things done safely, locally, and reliably. Help keep it that way.
