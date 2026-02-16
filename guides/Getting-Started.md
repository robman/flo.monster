# Getting Started with flo.monster

Zero to agent in three minutes. This guide walks you through creating your first AI agent with a living skin -- a web page the agent actively controls and inhabits.

## What You Need

- **A modern browser** -- Chrome, Edge, Firefox, or Safari (desktop or mobile)
- **An API key** from one of: [Anthropic](https://console.anthropic.com/), [OpenAI](https://platform.openai.com/), or [Google Gemini](https://aistudio.google.com/)

That's it. No install, no sign-up, no server. Everything runs in your browser. Reload and it's just there.

## Step 1: Open flo.monster

Navigate to [flo.monster](https://flo.monster) in your browser. Then click on the "Create a new agent" button to start.

## Step 2: Add Your API Key

You'll automatically be prompted to enter your API Key. You can change this at any time too.

1. Open **Settings** (the gear icon)
2. Go to **API Keys**
3. Select your provider (Anthropic, OpenAI or Gemini), paste your API key and save

Your key is encrypted locally using AES-GCM with a key derived via PBKDF2. It is stored in your browser's IndexedDB and never sent to [flo.monster](https://flo.monster)'s servers. The key is injected into API requests by a Service Worker running in your browser -- agents themselves never have access to it.

## Step 3: Create an Agent

You should now see the dashboard -- this is where your agents live.

1. Click the **New Agent** button to create a new agent
2. Type a message describing what you want -- for example: *"Show me a nice welcome message"*
3. The agent starts thinking, building, and updating its living skin in real time

## What Just Happened?

Here's what went on behind the scenes:

1. **Your message** was sent to the AI provider's API (using your encrypted key)
2. **The agent received your request** and began planning what to build
3. **It used tools** -- `dom` to create HTML elements, `state` to set up persistent data, `runjs` to add interactivity
4. **A living skin appeared** -- a web page the agent controls, visible in the viewport next to the chat

The agent runs inside a sandboxed iframe in your browser. It has its own isolated environment with access to web platform capabilities (DOM manipulation, HTTP requests, storage, JavaScript execution) but no access to your API key or the rest of your browser.

## Try These

Here are five prompts to get a feel for what agents can do:

- **"Create a game of tic-tac-toe you and I can play together"** -- A simple interactive game.
- **"Build a simple calculator"** -- A functional calculator with buttons and display, built in seconds.
- **"Make a drawing app"** -- A canvas-based drawing tool with colour picker and brush sizes.
- **"Create a quiz game about geography"** -- An interactive quiz with scoring, visual feedback, and multiple rounds.
- **"Build a weather dashboard"** -- Uses the `fetch` tool to pull live weather data and display it visually. (Requires a free weather API or public endpoint.)

For a slightly more sophisticated example where you create a 'Living Lists' agent where you can tap to speak naturally and your new items get sorted automatically - see [Living Lists](Living-Lists.md) for a full walkthrough.


## The Chat + UI Pattern

The default view is a split layout:

- **Left side:** Chat conversation with the agent. You type (or speak) messages, and the agent responds with text.
- **Right side:** The agent's living skin -- the web page it builds and controls.

Both sides are live. You can talk to the agent in the chat AND interact with the UI it creates. Click a button in the skin, and the agent sees that interaction and can respond. Ask a question in the chat, and the agent might update the skin to show you the answer.

This is the core pattern: **conversational input, visual output, bidirectional interaction**.

## View Modes

You can change how an agent is displayed using view modes:

| Mode | What You See | Best For |
|------|-------------|----------|
| **min** | Dashboard card (minimised) | Managing multiple agents at a glance |
| **max** | Full view -- chat + living skin side by side | Normal use, building and conversing |
| **ui-only** | Living skin only, chat hidden | Apps, games, immersive experiences |
| **chat-only** | Chat only, no skin viewport | Text-focused tasks, mobile use |

Both you and the agent can switch between these modes. For example, a game agent might request `ui-only` mode to give you a full-screen experience.

Note that on mobile devices you may only have `ui-only` and `chat-only` due to viewport space restrictions.

## Multi-Provider Support

[flo.monster](https://flo.monster) supports multiple AI providers:

- **Anthropic Claude**
- **OpenAI**
- **Google Gemini**
- **Ollama** -- Run local models with no API key needed (requires a [hub](Installing-A-Hub.md))

You can configure keys for multiple providers and choose which model each agent uses. **Switch models at any time -- your conversation and agent state are preserved**.

## Next Steps

- **[Living Lists](Living-Lists.md)** -- Walk through the flagship Personal Dashboard template in detail
- **[Templates](Templates.md)** -- Browse pre-built agent configurations and learn how templates work
- **[Installing a Hub](Installing-A-Hub.md)** -- Add persistence, system tools, and multi-browser coordination
- **[Voice](Voice.md)** -- Set up voice input and output for hands-free interaction
- **[Web UI](Web-UI.md)** -- Deep dive into DOM tools and how agents build interactive pages
