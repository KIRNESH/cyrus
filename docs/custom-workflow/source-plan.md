# Cyrus Full Workflow After the Minimum Test

This runbook starts **only after** `flow-cyrus-minimum-test-runbook.md` has succeeded completely.

The assumed working baseline is:

- One Vultr Ubuntu VM is running continuously.
- `cyrusadmin` is the Linux user that owns and runs Cyrus.
- Hostinger has the working `cyrus.YOUR_DOMAIN` A record.
- Caddy serves valid HTTPS and proxies to Cyrus on port 3456.
- Linear OAuth, callbacks, webhooks, and agent-session events work.
- Git and GitHub CLI authentication work for `cyrusadmin`.
- Codex device login works for `cyrusadmin`.
- `$HOME/.cyrus/config.json` exists.
- Cyrus uses `"defaultRunner": "codex"`.
- systemd starts Cyrus after logout and reboot.
- A disposable Linear issue caused Codex to edit only the requested file and open a GitHub pull request.

Do not start this runbook until all of those statements are true.

---

## What this runbook adds

The finished workflow should be:

```text
Create a product idea in Linear
  -> Cyrus and Codex write a read-only plan
  -> Cyrus waits for your approval
  -> approval creates planned feature sub-issues
  -> each feature gets its own plan and approval
  -> approved features build in separate worktrees
  -> human-only work becomes a Manual issue
  -> blocked agent work resumes when the Manual issue is completed
  -> every feature opens a pull request and runs CI
  -> Cyrus asks before merging
  -> an approved merge produces the configured preview or artifact
  -> the parent reports the final result
```

## Important reality check

The working minimum installation is only the foundation. The complete behavior is not enabled by one setting.

Current upstream Cyrus already provides useful primitives:

- Linear agent sessions and activity updates
- Codex as a runner
- one Git worktree per issue
- label-based modes and tool permissions
- Linear MCP tools
- parent and child session linking
- parent resumption when a child completes
- parking on unresolved Linear `blocked by` relations
- automatic wake-up when blockers finish
- an approval-elicitation helper
- GitHub pull-request support
- egress-control configuration

The following behavior still requires a maintained custom fork and tests:

- mandatory plan approval before any repository write
- revise-and-replan behavior
- applying that gate to every feature child
- dependable product-plan decomposition
- a standard Manual-ticket policy
- a final Merge approval
- persistent and idempotent approval state across restarts and duplicate webhooks

The approval and orchestration work is software development. It is not merely dashboard configuration.

## Recommended architecture

Keep the working minimum architecture while adding the full workflow:

```text
Hostinger DNS
  -> Caddy on the Vultr VM
  -> native Cyrus systemd service as cyrusadmin
  -> pinned Cyrus fork built under /opt/cyrus-fork/releases/
  -> Codex login under /home/cyrusadmin/.codex/
  -> Cyrus state under /home/cyrusadmin/.cyrus/
  -> GitHub repositories and Linear projects
```

This route deliberately does not migrate to Docker during the fork deployment. The dedicated Vultr VM already supplies the coarse virtual-machine boundary. Cyrus and Codex sandbox controls are enabled later in this runbook. Containerization can be evaluated after the whole workflow passes, but it is not required for approvals, subtasks, blockers, or pull requests.

## Placeholder rule

Never paste commands with placeholders unchanged. Replace these values first:

| Placeholder | Meaning |
|---|---|
| `VM_USER` | Normally `cyrusadmin` |
| `VULTR_IP` | The VM's public IPv4 address |
| `YOUR_DOMAIN` | Your actual domain |
| `GITHUB_OWNER` | Your GitHub username or organization |
| `GITHUB_REPO` | The first project repository |
| `LINEAR_PROJECT` | The Linear project connected to that repository |
| `YOUR_EMAIL` | The email allowed to control Cyrus |
| `FORK_TAG` | A pinned release such as `cyrus-full-v2026.10.1` |
| `NODE_EXECUTABLE` | The exact result of `command -v node` on the VM |

Commands marked **On your Mac** run in the Mac Terminal. Commands marked **On the VM** run after SSH has connected. Do not put `ssh` in front of commands that are already being run inside the VM.

---

# Phase 0 — Freeze the known-good minimum setup

## 0.1 Record the working versions

On the VM as `cyrusadmin`:

```bash
whoami
node --version
npm --version
cyrus --version
codex --version
command -v node
command -v cyrus
command -v codex
codex login status
gh auth status
```

`whoami` must print `cyrusadmin`. Save the non-secret version numbers and executable paths in a private note.

Do not copy authentication tokens or the contents of `$HOME/.codex/auth.json` into that note.

## 0.2 Back up the working Cyrus files locally on the VM

The configuration can contain Linear authorization data. Keep these backups on the VM and never commit them.

```bash
mkdir -p "$HOME/cyrus-backups/before-full-plan"
chmod 700 "$HOME/cyrus-backups"
cp "$HOME/.cyrus/.env" "$HOME/cyrus-backups/before-full-plan/cyrus.env"
cp "$HOME/.cyrus/config.json" "$HOME/cyrus-backups/before-full-plan/config.json"
sudo cp /etc/systemd/system/cyrus.service /etc/systemd/system/cyrus.service.before-full-plan
chmod 600 "$HOME/cyrus-backups/before-full-plan/cyrus.env"
chmod 600 "$HOME/cyrus-backups/before-full-plan/config.json"
```

Verify the backup without printing secrets:

```bash
jq empty "$HOME/cyrus-backups/before-full-plan/config.json"
ls -ld "$HOME/cyrus-backups" "$HOME/cyrus-backups/before-full-plan"
ls -l "$HOME/cyrus-backups/before-full-plan"
```

`jq empty` should print nothing.

## 0.3 Keep the global Cyrus installation for rollback

Do not uninstall `cyrus-ai`. The future fork will run from `/opt`, while the existing global installation remains the quick rollback.

Record the package:

```bash
npm list -g --depth=0 cyrus-ai
```

## 0.4 Reconfirm the baseline

```bash
systemctl is-enabled cyrus
systemctl is-active cyrus
systemctl is-enabled caddy
systemctl is-active caddy
curl -I https://cyrus.YOUR_DOMAIN
```

Create one final disposable issue in Linear and confirm it still produces a pull request. Close or cancel that issue before continuing.

Checkpoint:





- [x] Working versions and executable paths are recorded.
- [x] `.env`, `config.json`, and the systemd service have backups.
- [x] The old global Cyrus package remains installed.
- [x] The baseline pull-request test still passes.

---

# Phase 1 — Prepare Linear for the complete workflow

## 1.1 Keep one workspace and one team

You do not need a new Linear workspace for every project.

Use:

- one Linear workspace
- one suitable team, such as `APP`
- one Linear project per GitHub project or product
- one GitHub repository per independently versioned project

## 1.2 Create or verify the labels

In Linear:

1. Open the workspace.
2. Click the workspace name.
3. Open **Settings**.
4. Open **Issues → Labels**.
5. Create or verify these labels:

| Label | Purpose |
|---|---|
| `PRD` | Product idea and read-only planning |
| `Orchestrator` | Parent issue that coordinates child work |
| `Feature` | Approved implementation work |
| `Improvement` | Approved smaller implementation |
| `Bug` | Debugging and repair |
| `Manual` | Work that only you may do |
| `Delivery` | CI, previews, packaging, and deployment preparation |

Do not delegate `Manual` issues to Cyrus.

## 1.3 Verify workflow states

The team should have states equivalent to:

1. **Backlog** or **Triage**
2. **To Do**
3. **In Progress**
4. **In Review**
5. **Done**
6. **Canceled**

Do not create an `Approved` state. Approval is session state, not a general issue status.

## 1.4 Configure phone notifications

In the Linear mobile app:

1. Sign in to the correct workspace.
2. Open your profile or workspace settings.
3. Open **Notifications**.
4. Enable notifications for:
   - assignments
   - mentions
   - agent sessions
   - issue comments or replies
5. Allow Linear notifications in the phone's operating-system settings.

Checkpoint:





- [x] All seven labels exist.
- [ ] The workflow contains To Do, In Progress, In Review, and Done equivalents.
- [x] Linear agent-session notifications arrive on the phone.

---

# Phase 2 — Add upstream safety and routing controls first

Do this before installing the custom fork. It lets you test upstream controls independently from custom code.

## 2.1 Find your repository entry

On the VM:

```bash
jq '.repositories | to_entries | map({index: .key, name: .value.name, path: .value.repositoryPath, projectKeys: .value.projectKeys, routingLabels: .value.routingLabels})' "$HOME/.cyrus/config.json"
```

Write down the numeric index for the first test repository. It is normally `0` when only one repository exists.

## 2.2 Create another configuration backup

```bash
cp "$HOME/.cyrus/config.json" "$HOME/.cyrus/config.json.before-controls"
```

## 2.3 Add global controls

Open the real file:

```bash
nano "$HOME/.cyrus/config.json"
```

Preserve every generated field, especially `linearWorkspaces`, tokens, repository IDs, repository paths, and workspace IDs.

At the top level, make sure these fields exist:

```json
{
  "defaultRunner": "codex",
  "promptDefaults": {
    "scoper": {
      "allowedTools": "readOnly"
    },
    "builder": {
      "allowedTools": "all"
    },
    "debugger": {
      "allowedTools": "all"
    }
  },
  "userAccessControl": {
    "allowedUsers": [
      { "email": "YOUR_EMAIL" }
    ],
    "blockBehavior": "comment"
  },
  "repositories": [
    "KEEP THE REAL GENERATED REPOSITORY OBJECTS HERE"
  ]
}
```

The example is structural. Do not replace the actual `repositories` array or `linearWorkspaces` object with placeholder text.

Why these settings matter:

- `defaultRunner` makes Codex the normal runner.
- `scoper` is read-only for repository files.
- `builder` and `debugger` can work only after the future gate permits them.
- `allowedUsers` prevents another workspace member from starting privileged work through Cyrus.

Save the changes made in nano before continuing:

1. Press **Ctrl+O**. This means “write out,” or save.
2. Nano shows the current filename at the bottom. Do not change it.
3. Press **Return** to confirm the filename.
4. Press **Ctrl+X** to exit nano and return to the normal terminal prompt.

Check that the saved file is still valid JSON:

```bash
jq empty "$HOME/.cyrus/config.json"
```

Success prints nothing. If an error appears, restore the backup from step 2.2 and repeat step 2.3:

```bash
cp "$HOME/.cyrus/config.json.before-controls" "$HOME/.cyrus/config.json"
chmod 600 "$HOME/.cyrus/config.json"
```

## 2.4 Add repository routing and label modes

These settings perform two different jobs:

- `projectKeys` and `routingLabels` tell Cyrus **which repository** should receive the issue.
- `labelPrompts` tells Cyrus **which working mode** to use after it selects the repository.

For example, a planning issue can have both a repository-routing label such as `my-app` and the mode label `PRD`. The `my-app` label selects the repository; `PRD` selects read-only scoper mode.

Do not manually search through JSON braces. Use the repository's numeric index from step 2.1 and let `jq` update only that repository object.

### 2.4.1 Confirm the correct repository index

Run this on the VM:

```bash
jq -r '.repositories | to_entries[] | "index=\(.key)  name=\(.value.name)  path=\(.value.repositoryPath)"' "$HOME/.cyrus/config.json"
```

Example output:

```text
index=0  name=my-app  path=/home/cyrusadmin/.cyrus/repos/my-app
```

Find the line containing the repository you are configuring. Write down the number after `index=`. If the correct line says `index=0`, use `0` in the following steps. Do not assume the index is `0` when the list contains more than one repository.

Set the index as a temporary terminal variable. Replace `0` if your repository has a different index:

```bash
REPO_INDEX=0
```

There must be no spaces around the `=` sign. Keep this SSH terminal open while completing the rest of section 2.4.

Confirm that the variable points to the intended repository:

```bash
jq --argjson i "$REPO_INDEX" '.repositories[$i] | {name, repositoryPath, githubUrl, linearWorkspaceId}' "$HOME/.cyrus/config.json"
```

Stop if this prints the wrong repository or prints `null`. Return to the list above and correct `REPO_INDEX` before continuing.

### 2.4.2 Get the exact Linear project name

`projectKeys` expects the Linear **project name**, not the issue identifier, team key, workspace name, GitHub repository name, or project URL.

In Linear:

1. Open <https://linear.app> and enter the correct workspace.
2. In the left sidebar, click **Projects**.
3. Open the project that should send issues to this GitHub repository.
4. Copy the project name exactly as Linear displays it, including spaces and capitalization.
5. Return to the VM terminal.

Set that exact name as another temporary variable. Replace the example text between the single quotes:

```bash
LINEAR_PROJECT_NAME='Your exact Linear project name'
```

Keep the single quotes. They allow a project name to contain spaces.

### 2.4.3 Create or verify the repository-routing label

The routing label is a Linear issue label whose only job is to identify the target repository. It is separate from `PRD`, `Feature`, `Improvement`, `Delivery`, and `Bug`.

Use the repository name printed in step 2.4.1 unless you intentionally chose another unique routing label. For example, if the repository name is `my-app`, use a Linear label named `my-app`.

In Linear:

1. Click the workspace name in the upper-left corner.
2. Open **Settings**.
3. Open **Issues → Labels**.
4. Search for a label that exactly matches the repository name.
5. If it exists, leave it unchanged.
6. If it does not exist, click **New label** or **Create label**.
7. Enter the exact repository name as the label name.
8. Optionally enter `Routes this issue to the matching Cyrus repository` as its description.
9. Choose any color; the color does not affect Cyrus.
10. Save the label.
11. Return to the VM terminal.

Set the exact label name as a temporary variable. Replace the example:

```bash
ROUTING_LABEL='my-app'
```

The value must match the Linear label name exactly.

### 2.4.4 Review the three selected values

Run:

```bash
printf 'Repository index: %s\nLinear project: %s\nRouting label: %s\n' "$REPO_INDEX" "$LINEAR_PROJECT_NAME" "$ROUTING_LABEL"
```

Read all three lines. Do not continue until the repository index, project name, and routing label are correct.

### 2.4.5 Create a fresh backup

Run:

```bash
cp "$HOME/.cyrus/config.json" "$HOME/.cyrus/config.json.before-routing-and-modes"
chmod 600 "$HOME/.cyrus/config.json.before-routing-and-modes"
```

This backup is separate from the earlier backup and lets you undo only this routing change.

### 2.4.6 Generate the updated configuration safely

Copy and run this entire command exactly. Do not replace `$REPO_INDEX`, `$LINEAR_PROJECT_NAME`, or `$ROUTING_LABEL` inside the command; the shell fills them from the values you set above.

```bash
jq \
  --argjson i "$REPO_INDEX" \
  --arg project "$LINEAR_PROJECT_NAME" \
  --arg route "$ROUTING_LABEL" \
  '.repositories[$i].projectKeys = [$project]
   | .repositories[$i].routingLabels = [$route]
   | .repositories[$i].labelPrompts = {
       "scoper": {
         "labels": ["PRD"],
         "allowedTools": "readOnly"
       },
       "builder": {
         "labels": ["Feature", "Improvement", "Delivery"],
         "allowedTools": "all"
       },
       "debugger": {
         "labels": ["Bug"],
         "allowedTools": "all"
       }
     }' \
  "$HOME/.cyrus/config.json" > "$HOME/.cyrus/config.json.updated"
```

This creates a proposed file named `config.json.updated`. It does not yet replace the working configuration. It preserves the generated repository ID, path, branch, workspace ID, URL, and all other existing fields.

### 2.4.7 Validate and inspect the proposed file

First check that the proposed file is valid JSON:

```bash
jq empty "$HOME/.cyrus/config.json.updated"
```

Success produces no output. If an error appears, do not copy the proposed file over the real configuration. Repeat step 2.4.6 carefully.

Now display only the routing and mode settings for the selected repository:

```bash
jq --argjson i "$REPO_INDEX" '.repositories[$i] | {name, projectKeys, routingLabels, labelPrompts}' "$HOME/.cyrus/config.json.updated"
```

Check that:

- `name` is the intended repository.
- `projectKeys` contains the exact Linear project name.
- `routingLabels` contains the repository-routing label.
- `PRD` is under `scoper` with `readOnly` tools.
- `Feature`, `Improvement`, and `Delivery` are under `builder`.
- `Bug` is under `debugger`.

### 2.4.8 Install the validated file

Only after all checks above pass, run:

```bash
cp "$HOME/.cyrus/config.json.updated" "$HOME/.cyrus/config.json"
chmod 600 "$HOME/.cyrus/config.json"
rm "$HOME/.cyrus/config.json.updated"
```

Confirm the real file now contains the settings:

```bash
jq --argjson i "$REPO_INDEX" '.repositories[$i] | {name, projectKeys, routingLabels, labelPrompts}' "$HOME/.cyrus/config.json"
```

Do not add `Orchestrator` to `labelPrompts` yet. The custom fork must first define and test exactly how the parent planning gate changes into orchestration.

Do not add `Manual` to `labelPrompts`. Manual issues are human-only and must not be delegated to Cyrus.

When testing later, add both of these to the Linear issue:

1. The repository-routing label, such as `my-app`.
2. Exactly one mode label: `PRD`, `Feature`, `Improvement`, `Delivery`, or `Bug`.

Routing priority matters: Cyrus checks `routingLabels` before `projectKeys`. Therefore, never put another repository's routing label on the issue. If no repository-routing label is present, the matching Linear project can provide the repository match instead.

## 2.5 Validate before Cyrus reads the file

The file has already been saved and checked during steps 2.3 and 2.4. Run these final whole-file checks before restarting Cyrus:

Run:

```bash
jq empty "$HOME/.cyrus/config.json"
jq -r '.defaultRunner' "$HOME/.cyrus/config.json"
```

Expected:

- `jq empty` prints nothing.
- The second command prints `codex`.

If validation fails:

```bash
cp "$HOME/.cyrus/config.json.before-routing-and-modes" "$HOME/.cyrus/config.json"
chmod 600 "$HOME/.cyrus/config.json"
```

Then repeat section 2.4. The restored file keeps the global controls from step 2.3 but removes the routing and mode update.

## 2.6 Restart and inspect

Although Cyrus can hot-reload configuration, use one clean restart at this stage:

```bash
sudo systemctl restart cyrus
sudo systemctl status cyrus --no-pager
sudo journalctl -u cyrus -n 150 --no-pager
```

Look for configuration, schema, repository, authentication, or runner errors.

Checkpoint:



- [x] `defaultRunner` is `codex`.
- [x] Only your Linear identity can trigger Cyrus.
- [x] The first repository routes from the intended Linear project.
- [x] PRD, Feature, Improvement, Delivery, and Bug labels map to modes.
- [x] Cyrus starts without configuration errors.

---

# Phase 3 — Give each repository a Codex contract

Perform this phase in every project repository, beginning with the disposable test repository.

## 3.1 Add `AGENTS.md`

Codex reads `AGENTS.md`. Create it in the repository root.

Minimum template:

```markdown
# AGENTS.md

## Scope

This file applies to the entire repository.

## Safety

- Never commit secrets, tokens, `.env` files, private keys, or authentication caches.
- Never deploy production or merge a pull request without the explicit Cyrus approval gate.
- During planning, do not modify repository files.
- Change only what the Linear issue requests.

## Install

- Replace this line with the exact dependency-install command for this repository.

## Verify before opening a pull request

- Replace these lines with the real lint, test, build, and browser-check commands.
- Every listed command must pass or the final response must explain the failure.

## Pull requests

- Use one branch and pull request per Linear issue.
- Include the Linear issue identifier in the branch or pull-request text.
- Summarize changed files and verification results.

## Lessons

- Add only short, reusable lessons after a real recurring problem is solved.
```

Replace all instructional placeholder lines with commands that actually exist.

Examples:

| Stack | Typical verification |
|---|---|
| Node | `npm run lint`, `npm test`, `npm run build` |
| Python | `uv run ruff check .`, `uv run pytest` |
| Flutter | `flutter analyze`, `flutter test`, required builds |
| Go | `go vet ./...`, `go test ./...`, `go build ./...` |
| Rust | `cargo clippy`, `cargo test`, `cargo build` |
| Documents | strict document build, link check, spell check |
| Research | citation check, notebook reproduction, report build |

If Claude Code may be used later, create a small `CLAUDE.md` that points to `AGENTS.md`; do not maintain two conflicting instruction sets.

## 3.2 Add `cyrus-setup.sh`

This script runs inside every new issue worktree. It must be deterministic and must not contain secrets.

Example:

```bash
#!/usr/bin/env bash
set -euo pipefail

[ -f package-lock.json ] && npm ci
[ -f pnpm-lock.yaml ] && pnpm install --frozen-lockfile
[ -f pubspec.yaml ] && flutter pub get
[ -f pyproject.toml ] && uv sync
[ -f go.mod ] && go mod download
[ -f Cargo.toml ] && cargo fetch

echo "Worktree ready for ${LINEAR_ISSUE_IDENTIFIER}"
```

Remove every line that does not apply. If a repository could contain two JavaScript lockfiles, replace the generic checks with one explicit package-manager choice.

Make it executable:

```bash
chmod +x cyrus-setup.sh
```

## 3.3 Add optional teardown

Create `cyrus-teardown.sh` only if the project starts servers, creates databases, or allocates preview resources that must be removed when the issue closes.

Make teardown idempotent: running it twice should not damage anything.

## 3.4 Protect secrets

Verify `.gitignore` excludes the project's local secret files. Do not copy the VM's Cyrus `.env` or Codex authentication into a worktree.

## 3.5 Commit the repository contract

```bash
git add AGENTS.md cyrus-setup.sh .gitignore
git commit -m "Configure repository for Cyrus and Codex"
git push origin main
```

Add `cyrus-teardown.sh` to `git add` only if it exists.

Checkpoint:





- [ ] `AGENTS.md` names real commands and boundaries.
- [ ] `cyrus-setup.sh` is executable.
- [ ] No secret is in either file.
- [ ] The configuration is on the default branch.

---

# Phase 4 — Create and develop the Cyrus fork

## 4.1 Fork upstream on GitHub

On your Mac:

1. Open <https://github.com/cyrusagents/cyrus>.
2. Click **Fork**.
3. Select your GitHub account or organization.
4. Keep the repository name `cyrus`.
5. Create the fork.
6. Wait for GitHub to finish.

Public upstream repositories normally produce public forks. Never commit your Cyrus `.env`, Linear tokens, Codex authentication, or project secrets to this fork.

## 4.2 Clone the fork on your Mac

```bash
git clone https://github.com/GITHUB_OWNER/cyrus.git
cd cyrus
git remote add upstream https://github.com/cyrusagents/cyrus.git
git fetch upstream
git remote -v
git rev-parse HEAD
```

The `origin` URLs should use your fork. The `upstream` URLs should use `cyrusagents/cyrus`.

## 4.3 Install and test the unchanged source

The repository declares its required pnpm version. Use Corepack:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:packages:run
pnpm build
```

Do not modify the fork until the unchanged source builds and tests successfully.

If a clean upstream test fails, record the exact failing test and determine whether it is an existing upstream problem. Do not hide it by deleting tests.

## 4.4 Use separate branches and pull requests

Implement the workflow in this order:

1. approval state machine
2. orchestrator decomposition
3. Manual-ticket behavior
4. merge approval
5. optional status page

Use one branch and pull request for each. Do not combine all behavior into one unreviewable change.

## 4.5 Fork change 1 — persistent plan approval gate

Create the branch:

```bash
git switch -c feature/persistent-plan-approval
```

Give Codex this implementation specification inside the Cyrus fork:

```text
Inspect the current Cyrus source before editing. Implement a runner-agnostic,
persistent Linear plan-approval state machine. Reuse the current activity and
elicitation abstractions, including createApprovalElicitation where appropriate.

Required states:
planning -> awaiting_plan_approval -> implementing -> in_review

Requirements:
1. A newly delegated PRD or implementation issue starts with scoper/read-only
   repository permissions.
2. When a usable plan is ready, post it to the Linear agent session, create an
   approval interaction, and park the session.
3. No repository write, shell mutation, branch, commit, or pull request may occur
   before approval.
4. Approve resumes using the appropriate next mode. A parent product idea goes
   to orchestration; a feature child goes to builder.
5. Revise keeps the session read-only, injects the requested changes, produces a
   new plan, and asks again.
6. Reject or cancel ends safely without implementation.
7. Persist gate state and correlation IDs so a daemon restart does not lose an
   outstanding approval.
8. Handle duplicate callbacks and duplicate Linear webhooks idempotently.
9. Only an identity accepted by Cyrus userAccessControl may approve.
10. Keep the implementation runner-agnostic and test it with the Codex runner.
11. Add unit and integration tests for approve, revise, reject, restart recovery,
    duplicate delivery, and unauthorized approval.
12. Do not change unrelated behavior.
```

Important: an elicitation helper existing in upstream does not by itself create this gate. The fork must connect the state machine to the normal issue flow and persist its state.

Run after implementation:

```bash
pnpm typecheck
pnpm test:packages:run
pnpm build
git status
git diff --check
```

Commit and push only when they pass:

```bash
git add .
git commit -m "Add persistent Linear plan approval gate"
git push -u origin feature/persistent-plan-approval
```

Open a GitHub pull request into your fork's `main`, review it, and merge it.

## 4.6 Fork change 2 — controlled product decomposition

Update local `main`, then branch:

```bash
git switch main
git pull --ff-only
git switch -c feature/approved-product-decomposition
```

Implementation specification:

```text
Implement approved product-plan decomposition using current Cyrus and Linear MCP
interfaces.

Requirements:
1. Only an approved parent plan may enter orchestrator mode.
2. Create one child issue per independently reviewable feature.
3. Set the Linear parentId, project, team, To Do state, and Feature label.
4. Delegate children to Cyrus through the supported Linear agent mechanism.
5. Every child must start in the planning gate even though it is a Feature issue.
   Do not let the Feature label bypass child planning approval.
6. Each approved child receives its own worktree and builder session.
7. Track the complete expected child set persistently.
8. Do not mark the parent complete after only the first child finishes.
9. Resume or summarize the parent as children finish, and produce the final parent
   summary only after all required children reach a terminal result.
10. Report failed or canceled children clearly instead of silently declaring success.
11. Make duplicate decomposition safe: the same parent approval must not create
   duplicate children.
12. Add tests for zero, one, and multiple children; duplicate callbacks; one failed
   child; and restart recovery.
13. Keep initial execution conservative for a small VM: create all child issues but
   delegate at most one build child at a time until concurrency is deliberately tested.
```

Run the same typecheck, tests, build, diff check, commit, push, review, and merge sequence used for change 1.

## 4.7 Fork change 3 — Manual tickets and blocker behavior

Create:

```bash
git switch main
git pull --ff-only
git switch -c feature/manual-ticket-contract
```

Implementation specification:

```text
Add a standard Manual-ticket rule to Cyrus planning, building, debugging, and
orchestration prompts.

Create a Manual issue when work requires any of these:
- a credential, secret, certificate, or account
- spending money or accepting vendor lock-in
- a DNS, OAuth, app-store, billing, or identity action
- a host package or system-service change
- a production deployment decision
- an action outside the worktree or current agent authority

Requirements:
1. The Manual issue is assigned to the authorized human, labelled Manual, and is
   not delegated to Cyrus.
2. Add a Linear blocked-by relation from the waiting agent issue to the Manual issue.
3. Park the agent work while the blocker is unresolved.
4. Use this body contract:

## Why
One sentence explaining what is blocked.

## Options
Only for a real decision: cost, effort, lock-in, risks, and a recommendation.

## Steps
Exact browser clicks or commands for the human.

## Hand-back
Exactly where the result belongs, without asking for a secret in a Linear comment.

## Verify
The non-secret check Cyrus will perform after the issue is completed.

5. When the Manual issue becomes Done, rely on or extend Cyrus's blocker wake-up
   behavior, run the Verify step, and continue.
6. Never request a secret in Linear, GitHub, a pull request, or an issue comment.
7. Avoid duplicate Manual issues for the same blocker.
8. Add tests for creation, assignment, parking, wake-up, failed verification, and
   duplicate webhook delivery.
```

Run the full checks, then commit, push, review, and merge.

## 4.8 Fork change 4 — protected merge approval

Create:

```bash
git switch main
git pull --ff-only
git switch -c feature/protected-merge-approval
```

Implementation specification:

```text
Implement an explicit Linear merge gate after a Cyrus-created pull request is ready.

Required states:
in_review -> awaiting_merge_approval -> merging -> done

Requirements:
1. Ask for merge approval only after the pull request exists and required checks pass.
2. Display repository, pull-request number, base branch, head branch, changed-file
   summary, test results, and preview link when available.
3. No response, Reject, or Cancel must never merge.
4. Only an authorized Linear user may approve.
5. Before merging, re-fetch the pull request and verify it is the same open pull
   request created for this issue, its checks still pass, and its base branch is allowed.
6. Merge with squash and delete the branch only after all checks pass.
7. Respect GitHub branch protection. Never bypass required checks or admin controls.
8. Make repeated callbacks idempotent: an already merged pull request must not cause
   a second action or an error loop.
9. Post the merge result and resulting commit link to Linear.
10. Add tests for approve, reject, stale pull request, changed head SHA, failing
    checks, unauthorized user, duplicate callback, and restart recovery.
```

Run the full checks, then commit, push, review, and merge.

## 4.9 Run the complete fork test suite

After all four pull requests are merged:

```bash
git switch main
git pull --ff-only
git status
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:packages:run
pnpm build
```

`git status` must be clean.

Checkpoint:





- [ ] Clean upstream built before modifications.
- [ ] Each behavior was implemented in a separate reviewed pull request.
- [ ] Approval state persists across restart.
- [ ] Child issues cannot bypass approval.
- [ ] Manual tickets never request secrets in Linear.
- [ ] Merge approval rechecks the pull request and CI.
- [ ] The complete fork builds and tests successfully.

---

# Phase 5 — Tag and deploy the fork to Vultr

## 5.1 Create a pinned release tag

On your Mac in the fork:

```bash
git switch main
git pull --ff-only
git status
git tag cyrus-full-v2026.10.1
git push origin cyrus-full-v2026.10.1
```

Use a new tag for every deployed change. Never deploy moving `main` or `latest` to the always-running VM.

In this example, `FORK_TAG` is `cyrus-full-v2026.10.1`.

## 5.2 Check VM build capacity

On the VM:

```bash
free -h
swapon --show
df -h
node --version
command -v node
```

The source build needs free disk space and may need swap on a small VM. If no swap is listed, create a 2 GB swap file:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

Run those swap-creation commands only once. Do not append a duplicate `/swapfile` line if the file is already configured.

## 5.3 Install source-build prerequisites

```bash
sudo apt update
sudo apt install -y git build-essential python3 make g++
sudo mkdir -p /opt/cyrus-fork/releases
sudo chown -R cyrusadmin:cyrusadmin /opt/cyrus-fork
```

## 5.4 Clone the pinned tag

```bash
cd /opt/cyrus-fork/releases
git clone --branch FORK_TAG --depth 1 https://github.com/GITHUB_OWNER/cyrus.git FORK_TAG
cd /opt/cyrus-fork/releases/FORK_TAG
git describe --tags --exact-match
```

The last command must print exactly the tag you intended to deploy.

## 5.5 Build the fork on the VM

Use the pnpm version currently declared by the fork. If it is still `10.33.1`:

```bash
npx -y pnpm@10.33.1 install --frozen-lockfile
npx -y pnpm@10.33.1 build
node apps/cli/dist/src/app.js --version
```

If the fork's root `package.json` declares a different `packageManager`, use that exact pnpm version instead.

Do not continue if the build or version command fails.

## 5.6 Point systemd at the fork

First record the Node executable:

```bash
command -v node
```

Open the service:

```bash
sudo nano /etc/systemd/system/cyrus.service
```

Keep the existing unit settings, user, environment file, restart policy, and PATH. Ensure these lines use real values:

```ini
[Service]
User=VM_USER
WorkingDirectory=/home/VM_USER
Environment="HOME=/home/VM_USER"
EnvironmentFile=/home/VM_USER/.cyrus/.env
Environment="PATH=/home/VM_USER/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=NODE_EXECUTABLE /opt/cyrus-fork/releases/FORK_TAG/apps/cli/dist/src/app.js
Restart=always
RestartSec=5
```

There must be exactly one active `ExecStart` line.

Save, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl restart cyrus
sudo systemctl status cyrus --no-pager
sudo journalctl -u cyrus -n 200 --no-pager
```

Verify:

```bash
curl -I https://cyrus.YOUR_DOMAIN
codex login status
gh auth status
```

## 5.7 Know the rollback before testing

If the fork does not start or breaks the existing flow:

```bash
sudo cp /etc/systemd/system/cyrus.service.before-full-plan /etc/systemd/system/cyrus.service
sudo systemctl daemon-reload
sudo systemctl restart cyrus
sudo systemctl status cyrus --no-pager
```

The original global Cyrus package was intentionally kept for this rollback.

Checkpoint:





- [ ] The VM is running an exact fork tag.
- [ ] The service uses the same `cyrusadmin` home, `.env`, config, Codex login, and GitHub login.
- [ ] HTTPS still works.
- [ ] The original service file can be restored quickly.

---

# Phase 6 — Configure and verify the new workflow

## 6.1 Add the fork-specific orchestrator mapping

The fork must document the exact configuration key it introduced or confirmed for orchestrator routing. Do not guess it from an old HTML line.

After reading the fork's tested configuration example:

1. Back up the live config.
2. Add `Orchestrator` routing exactly as the fork expects.
3. Validate with `jq empty`.
4. Restart Cyrus.
5. Inspect logs.

Commands:

```bash
cp "$HOME/.cyrus/config.json" "$HOME/.cyrus/config.json.before-orchestrator"
nano "$HOME/.cyrus/config.json"
jq empty "$HOME/.cyrus/config.json"
sudo systemctl restart cyrus
sudo journalctl -u cyrus -n 200 --no-pager
```

## 6.2 Test the parent planning gate only

In the disposable Linear project:

1. Create a new issue titled `Approval test: plan only`.
2. Description: `Plan a README-only change. Do not implement until approved.`
3. Add `PRD`.
4. Delegate to Cyrus.
5. Wait for the plan and approval interaction.
6. Do not approve yet.
7. On GitHub, confirm no branch or pull request was created.
8. On the VM, confirm no repository change was committed.
9. Reboot the VM while the approval is waiting.
10. Reconnect and verify the same approval is still pending.
11. Request a revision.
12. Confirm it replans without writing code.
13. Approve the revised plan.

Pass condition: no repository mutation occurred before approval, and restart did not lose the gate.

## 6.3 Test child planning gates

Create a parent plan containing two tiny independent README features.

Approve the parent and confirm:

1. Exactly two child issues are created.
2. Each child has the correct `parentId` relationship in Linear.
3. Each child uses the correct project, team, state, and label.
4. Neither child implements immediately.
5. Each child produces its own plan and approval.
6. Only one child builds at a time for the first test.
7. Each child uses a separate worktree and branch.
8. The parent does not report completion after only one child finishes.
9. The parent summarizes both results when both are terminal.

## 6.4 Test Manual blocking

Use a harmless fake requirement, such as `Pretend this change requires a TEST_SERVICE_TOKEN; do not ask for a real secret.`

Confirm:

1. Cyrus creates one `Manual` issue.
2. The issue is assigned to you and not delegated to Cyrus.
3. It contains Why, Steps, Hand-back, and Verify.
4. The agent issue has a Linear `blocked by` relation.
5. Cyrus parks the agent work.
6. Completing the Manual issue wakes the agent.
7. The agent runs its non-secret verification step.
8. No secret is requested in the Linear thread.

Cancel this fake test after behavior is verified.

## 6.5 Test merge approval

Let an approved README child open a pull request.

Confirm:

1. Cyrus waits for required checks.
2. Cyrus displays the correct pull request and commit/head information.
3. Ignoring the card does not merge.
4. Rejecting does not merge.
5. Create another test and approve it.
6. Cyrus rechecks the pull request and merges only the approved one.
7. Linear receives the final merge link.

Checkpoint:





- [ ] Parent plan approval works across restart.
- [ ] Every child has its own approval.
- [ ] Multiple children are tracked as a set.
- [ ] Manual blocker wake-up works.
- [ ] Merge rejection is safe.
- [ ] Merge approval rechecks CI and pull-request identity.

---

# Phase 7 — Enable Cyrus and Codex sandbox controls

Do this only after the forked workflow works without the extra sandbox layer. Otherwise a workflow bug and a sandbox denial are difficult to distinguish.

## 7.1 Install Linux prerequisites

On the VM:

```bash
sudo apt update
sudo apt install -y bubblewrap socat ripgrep
bwrap --version
socat -V
rg --version
```

## 7.2 Back up and edit Cyrus configuration

```bash
cp "$HOME/.cyrus/config.json" "$HOME/.cyrus/config.json.before-sandbox"
nano "$HOME/.cyrus/config.json"
```

Add this top-level object while preserving all other data:

```json
{
  "sandbox": {
    "enabled": true,
    "logRequests": true,
    "networkPolicy": {
      "preset": "trusted"
    }
  }
}
```

Do not set `systemWideCert` to `true` unless the generated Cyrus CA has actually been installed into the system trust store.

Do not add custom API domains until a real project needs them.

## 7.3 Validate and restart

```bash
jq empty "$HOME/.cyrus/config.json"
sudo systemctl restart cyrus
sudo systemctl status cyrus --no-pager
sudo journalctl -u cyrus -n 250 --no-pager
```

If logs show a Bubblewrap or user-namespace permission failure, restore the backup first:

```bash
cp "$HOME/.cyrus/config.json.before-sandbox" "$HOME/.cyrus/config.json"
sudo systemctl restart cyrus
```

Do not immediately disable Ubuntu security controls or run Cyrus as root. Investigate the exact Bubblewrap, AppArmor, or Codex sandbox error first.

## 7.4 Run a sandbox smoke test

Use a disposable issue that:

- reads files inside its own worktree
- edits one allowed file after approval
- runs Git and GitHub commands
- installs only the repository's declared dependencies
- tries no production action

Verify:

1. Required package and GitHub domains work.
2. Work occurs only in the issue worktree.
3. The PR still opens.
4. Cyrus logs the allowed requests.
5. An unapproved domain is denied when deliberately tested in a safe throwaway issue.

The sandbox reduces risk; it does not make arbitrary untrusted repositories safe. Keep the VM free of personal data and unrelated credentials.

Checkpoint:





- [ ] Bubblewrap prerequisites exist.
- [ ] Cyrus starts with sandboxing enabled.
- [ ] Normal Git, package, and PR operations work.
- [ ] Worktree boundaries remain intact.
- [ ] Denied network access fails without disabling the whole sandbox.

---

# Phase 8 — Add CI and delivery one project at a time

Do not create every possible mobile and cloud integration immediately. Start with CI checks, then add only the preview type the project needs.

## 8.1 Create two delivery issues

For each project, the approved orchestrator should create these before feature children:

1. `Delivery: accounts and secrets`
   - Label: `Manual`
   - Assigned to you
   - Not delegated
   - Lists accounts and GitHub secret names without containing secret values
2. `Delivery: CI pipeline`
   - Label: `Delivery`
   - Delegated to Cyrus
   - Blocked by the accounts-and-secrets issue

Feature implementation should wait until the minimum CI pipeline succeeds.

## 8.2 Start with GitHub Actions checks

The CI child should create `.github/workflows/ci.yml` using the exact commands in `AGENTS.md`.

Minimum sequence:

1. Checkout.
2. Install the pinned toolchain.
3. Install dependencies from the lockfile.
4. Lint or analyze.
5. Test.
6. Build.
7. Upload a useful artifact when applicable.

## 8.3 Require checks

After the workflow succeeds once:

1. Open the GitHub repository.
2. Open **Settings**.
3. Open **Rules → Rulesets**, or **Branches** if Rulesets is unavailable.
4. Protect the default branch.
5. Require a pull request.
6. Require the exact CI check names.
7. Do not allow the Cyrus GitHub identity to bypass the rule.
8. Save.

Re-test the merge gate. It must wait when CI is pending or failing.

## 8.4 Choose one preview path

| Project type | First useful delivery |
|---|---|
| Static web or documentation | GitHub Pages or Cloudflare Pages preview |
| Node/API service | Test build first; add a review-app provider only when needed |
| Android | Debug APK as a GitHub Actions artifact; Firebase App Distribution later |
| iOS | Simulator tests on a separately secured Mac runner; TestFlight later |
| Research | Rendered report, notebook output, or Pages documentation |
| Data pipeline | Reproducible sample output artifact |

The Vultr Cyrus VM is the control plane. Do not deploy every preview application onto the control-plane VM by default.

## 8.5 Keep secrets human-controlled

For GitHub Actions secrets:

1. Open repository **Settings**.
2. Open **Secrets and variables → Actions**.
3. Click **New repository secret**.
4. Enter the exact name from the Manual delivery issue.
5. Paste the value.
6. Save.
7. Mark the Manual issue Done only after every required secret is present.

Never paste secret values into Linear, a commit, `AGENTS.md`, or workflow YAML.

Checkpoint:





- [ ] CI uses the commands in `AGENTS.md`.
- [ ] Branch protection requires CI.
- [ ] The merge gate respects the protection.
- [ ] At least one useful preview or artifact exists when the project needs it.
- [ ] Secrets remain outside the repository and Linear.

---

# Phase 9 — Optional read-only Cyrus status page

Skip this until approvals, subtasks, blocking, CI, and merging are reliable.

If Linear views are insufficient, add only a read-only status page to the fork:

- `GET /ui` for one small page
- `GET /api/sessions` for sanitized session state
- optional server-sent events for live updates
- links to Linear and GitHub
- no approval, merge, chat, or mutation controls
- no secrets, prompts containing secrets, authentication tokens, or unrestricted log downloads

The page should show:

- issue identifier
- runner
- state: planning, awaiting approval, building, blocked, in review, awaiting merge, done, or error
- last safe activity summary
- elapsed time
- Linear issue link
- pull-request link

Do not expose these routes publicly without authentication. Because the webhook routes must remain public, use separate Caddy route protection for `/ui` and `/api/*`, or make the status page reachable only over a private network such as Tailscale.

Keep all approvals in Linear so there is one authoritative decision interface.

---

# Phase 10 — Full end-to-end acceptance test

Run this entire test in a disposable repository before trusting a real project.

## 10.1 Parent issue

Create:

```text
Title: Build the full Cyrus acceptance sample

Description:
Plan a tiny documentation feature with two independent child changes:
1. Add docs/alpha.md containing one heading and one paragraph.
2. Add docs/beta.md containing one heading and one paragraph.
3. After both files are complete, add links to them from README.md.
Do not change any other files.
```

Add `PRD` and delegate to Cyrus.

## 10.2 Required observations

Check every item:





- [ ] Parent starts read-only.
- [ ] Parent posts a plan.
- [ ] No branch exists before approval.
- [ ] Revision returns to planning.
- [ ] Approval creates exactly three feature children: alpha, beta, and README integration.
- [ ] All three children have the correct parent.
- [ ] The README integration child is blocked by both document children.
- [ ] Every child asks for its own approval.
- [ ] Only an approved, unblocked child begins implementation.
- [ ] Each child uses its own branch and worktree.
- [ ] CI runs on each pull request.
- [ ] The merge gate appears only after checks pass.
- [ ] Rejecting one merge leaves its pull request open.
- [ ] Approving the correct merge merges only that pull request.
- [ ] The README integration child wakes only after both document children finish.
- [ ] The parent waits for all three child terminal results.
- [ ] Linear contains links to all pull requests and results.

## 10.3 Failure and recovery tests

Also test:

1. Reboot while a plan waits for approval.
2. Reboot while a Manual blocker is pending.
3. Send the same approval twice.
4. Send the same webhook twice if the test harness supports it.
5. Make one child CI check fail.
6. Cancel one child.
7. Attempt approval from a non-allowed Linear identity if a second test user is available.
8. Change a pull-request head after the merge card appears and confirm Cyrus refuses the stale approval.

The full system is not complete until failures are reported honestly and do not cause unauthorized implementation or merging.

---

# Phase 11 — Daily phone workflow

After all acceptance tests pass:

1. Open the correct Linear project.
2. Create a parent issue describing the product idea and constraints.
3. Add `PRD`.
4. Delegate it to Cyrus.
5. Read the plan in the agent session.
6. Reply with questions or request revisions.
7. Approve only when scope and acceptance criteria are clear.
8. Review the generated feature children.
9. Approve each child plan separately.
10. Complete any `Manual` issues without putting secrets in Linear.
11. Watch CI and previews from the linked pull requests.
12. Approve merges only after reviewing the diff, checks, and preview.
13. Confirm the parent summary matches the delivered work.
14. Move the parent to Done only when the complete outcome is correct.

To stop unsafe work:

1. Use the supported stop action or instruction in the Linear agent session.
2. If necessary, SSH to the VM.
3. Stop the service:

```bash
sudo systemctl stop cyrus
```

4. Inspect logs and affected branches before restarting.

---

# Phase 12 — Add another project

Repeat this for each new project; do not create another Linear workspace.

1. Create or select the GitHub repository.
2. Create one Linear project.
3. Add `AGENTS.md` and `cyrus-setup.sh` to the repository.
4. On the VM, run:

```bash
cyrus self-add-repo https://github.com/GITHUB_OWNER/NEW_REPO.git
```

5. Back up `config.json`.
6. Add the new project's `projectKeys`, `routingLabels`, and label modes to only its repository object.
7. Validate with `jq empty`.
8. Restart Cyrus and inspect logs.
9. Run a README-only approval and pull-request test.
10. Add CI.
11. Add only the toolchain and preview type that project requires.

Do not give every project access to every tool, credential, or deployment account.

---

# Phase 13 — Maintenance and cost control

## 13.1 Sync the fork monthly

On your Mac:

```bash
cd cyrus
git switch main
git fetch upstream
git merge upstream/main
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:packages:run
pnpm build
```

Resolve conflicts without deleting the gate tests. Create a new immutable tag, deploy it as a new `/opt/cyrus-fork/releases/FORK_TAG` directory, switch systemd, and repeat the acceptance smoke test.

Never overwrite a deployed release directory. Keeping the previous directory makes rollback simple.

## 13.2 Monitor the service

```bash
systemctl is-active cyrus
systemctl is-active caddy
sudo journalctl -u cyrus -n 200 --no-pager
sudo journalctl -u caddy -n 100 --no-pager
df -h
free -h
```

## 13.3 Watch spending

The $50 Vultr balance pays only Vultr charges.

Potential separate costs include:

- Codex or OpenAI usage, depending on the authentication plan
- GitHub Actions beyond the account allowance
- preview hosting beyond free tiers
- Firebase, databases, storage, or external APIs
- optional Vultr snapshots and backups

Powering the VM off normally does not stop Vultr billing. Destroy it when the system is abandoned and the required configuration has been backed up securely.

Start with one active build child at a time on a small VM. Several simultaneous Codex builds can exhaust memory, process limits, or API allowances.

## 13.4 Rotate and protect credentials

- Keep `$HOME/.cyrus/.env` mode `600`.
- Keep `$HOME/.codex/` private to `cyrusadmin`.
- Never store a backup in the project repositories.
- Revoke old GitHub, Linear, deployment, and API credentials when replaced.
- Restrict the GitHub identity to only repositories Cyrus needs.
- Review `userAccessControl` whenever workspace membership changes.

---

# Completion definition

The whole plan is complete only when all of these are true:





- [ ] Cyrus runs continuously after reboot.
- [ ] Codex is the default runner.
- [ ] Only approved Linear users can control it.
- [ ] Planning is read-only.
- [ ] No implementation occurs before explicit plan approval.
- [ ] Revision returns safely to planning.
- [ ] Approved parents create the intended children exactly once.
- [ ] Every build child has its own plan approval.
- [ ] Child worktrees, branches, and pull requests are isolated.
- [ ] Manual work creates a human-owned blocker without leaking secrets.
- [ ] Completing a blocker wakes and verifies the waiting work.
- [ ] CI and required checks protect the default branch.
- [ ] Merge requires explicit approval and revalidation.
- [ ] Restart and duplicate-webhook tests pass.
- [ ] Sandbox controls work for the real repository.
- [ ] The previous Cyrus release can be restored quickly.
- [ ] The complete disposable-repository acceptance test passes before a real project is connected.

---

# Primary references

- [Cyrus repository and current capabilities](https://github.com/cyrusagents/cyrus)
- [Cyrus self-hosting guide](https://github.com/cyrusagents/cyrus/blob/main/docs/SELF_HOSTING.md)
- [Cyrus configuration reference](https://github.com/cyrusagents/cyrus/blob/main/docs/CONFIG_FILE.md)
- [Cyrus setup and teardown scripts](https://github.com/cyrusagents/cyrus/blob/main/docs/SETUP_SCRIPTS.md)
- [Cyrus GitHub authentication guide](https://github.com/cyrusagents/cyrus/blob/main/docs/GIT_GITHUB.md)
- [Cyrus AgentSessionManager approval helper](https://github.com/cyrusagents/cyrus/blob/main/packages/edge-worker/src/AgentSessionManager.ts)
- [Cyrus EdgeWorker parent, child, and blocker logic](https://github.com/cyrusagents/cyrus/blob/main/packages/edge-worker/src/EdgeWorker.ts)
- [Codex CLI installation](https://developers.openai.com/codex/cli/)
- [Codex authentication](https://learn.chatgpt.com/codex/auth)
- [Linear agent interaction guidelines](https://linear.app/developers/agents)
- [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
