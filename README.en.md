# Plasmod

A self-hosted control panel for directing a team of AI agents from your phone.

Answer agents with decision cards, chat with them, share tasks and notes, and watch your VPS. Nothing is exposed to the public internet: the only way in is [Tailscale](https://tailscale.com/).

The name comes from *plasmodium*, the shape-shifting body of a slime mold.

[日本語](README.md)

## Features

| | |
|---|---|
| **Decision cards** | Everything waiting on you is a task: blocked work, reviews, tool permissions, mail that needs a reply |
| **Tasks** | Four states (waiting on you, to do, delegated, done), parents, links, tags and due dates |
| **Chat** | Talk to agents, send photos and files, search past conversations |
| **Notes** | Markdown with live preview, projects, tags and history. Works offline and syncs later; conflicting edits are kept as a copy |
| **Voice notes** | Keep talking with the phone on your desk (Android) |
| **Root approvals** | Agents request root work; you read the diff and approve with a password. You can also run a command yourself |
| **Reports** | Daily story-style reports and scheduled reports |
| **Settings** | Usage and cost, models, schedules, VPS status, a read-only file viewer |
| **Android app** | Notifications with action buttons, home screen widgets |

## Install

You need an Ubuntu VPS, [Tailscale](https://tailscale.com/) logged in, and [Hermes Agent](https://github.com/NousResearch/hermes-agent) installed.

```sh
git clone <this repository> plasmod && cd plasmod
sudo ./setup.sh --check   # only checks the prerequisites
sudo ./setup.sh
```

It prints your address when done. Open it from a device on your tailnet, then set your name and your agents' names and avatars under **Settings → General**. Agents are found automatically from your Hermes profiles. Your personal settings stay on your VPS.

The Android app is on the [Releases](../../releases) page; enter the address on its first screen.

Details, optional parts and troubleshooting are in [docs/INSTALL.md](docs/INSTALL.md) (Japanese). The app's interface is currently Japanese only.

> **Status**: used daily by the author. The install script has not yet been tested on a clean server.

## How it stays safe

- **Separate OS users** for the app, the agents and root work. An agent cannot approve its own request.
- **No public port.** Tailscale identifies you; requests from the VPS itself are refused.
- **Secrets are not given to agents.** Agents only get fixed operations through a small broker.
- **Root work is approved one request at a time**, with a password, and is logged.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (Japanese) for diagrams.

## Development

```sh
bun install
bun run build
PLASMOD_KANBAN_SOURCE=fixture PLASMOD_DEV_NO_AUTH=1 bun run src/server/index.ts   # http://127.0.0.1:8790
bun test
```

## License

[MIT](LICENSE)
