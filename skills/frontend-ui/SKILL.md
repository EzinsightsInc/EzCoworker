---
name: frontend-ui
description: Improves the frontend chat UI and user experience. Use when adding UI features, fixing layout issues, improving the chat interface, styling components, adding animations, handling loading/error states, or making the app more responsive. Covers vanilla JS, Tailwind CSS, and the chat/sidebar layout.
argument-hint: "[component or feature to improve]"
---

You are improving the frontend of a single-page chat application. All UI lives in one file: `frontend/public/index.html`.

## Tech Stack
- **Tailwind CSS** loaded via CDN (`https://cdn.tailwindcss.com`) — use utility classes directly, no build step
- **marked.js** via CDN — used to render markdown in assistant messages via `marked.parse()`
- **Vanilla JS** — no framework, no bundler, no TypeScript
- **Color palette**: gray-900 background, gray-800 panels, gray-700 inputs, blue-600 accents, green-500 status indicators

## Current Layout Structure
```
body (bg-gray-900, flex-col)
├── #auth-screen          — login/register form (hidden after login)
└── #chat-screen          — main app (hidden before login)
    ├── header bar        — app name + logout button
    └── flex row
        ├── #sidebar      — w-64, conversation list + "New Conversation" button
        └── chat area
            ├── #messages — scrollable message list
            └── input bar — textarea + submit button
```

## Message Bubble Conventions
- **User messages**: `ml-auto bg-blue-600 rounded-br-none` (right-aligned)
- **Assistant messages**: `mr-auto bg-gray-700 rounded-bl-none` (left-aligned)
- Both: `max-w-[85%] p-4 rounded-2xl shadow-md`
- Loading state: animated `loading-dots` class with CSS `content` animation
- Markdown is rendered via `parseContent()` → `marked.parse()` with `<think>` tag replacement

## UI Best Practices for This Project

### Loading & Error States
- Always show a loading indicator while awaiting agent response (currently uses `loading-dots` CSS animation)
- Replace loading message with actual response or a red error message on failure
- Disable the submit button and textarea while a request is in flight to prevent duplicate sends

### Scrolling
- After appending a message: `container.scrollTop = container.scrollHeight`
- Smooth scroll preferred: `container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })`

### Conversation Sidebar
- Active conversation: `bg-blue-800` highlight (currently `bg-blue-700` — use darker for contrast)
- Truncate long titles with `truncate` class
- Show relative timestamps (e.g. "2 hours ago") instead of `toLocaleDateString()` for better UX
- Add a delete button (×) on hover for each conversation item

### Input Area
- Auto-resize textarea as user types (set `rows` dynamically based on content)
- Clear input immediately on send, before awaiting response
- Show character count if approaching a limit
- Keyboard shortcut hint: "Enter to send · Shift+Enter for new line" in the footer text

### Accessibility
- All interactive elements need `aria-label` if they have no visible text (icon-only buttons)
- Use `role="log"` and `aria-live="polite"` on `#messages` so screen readers announce new messages
- Focus the textarea after sending a message and after loading a conversation

### Responsive Design
- Sidebar collapses on mobile: hide with `hidden md:flex` and add a hamburger toggle
- Message bubbles: `max-w-[85%]` works well; reduce to `max-w-full` on very small screens
- Input bar: ensure textarea doesn't overflow on narrow viewports

### Code Style
- Use `escapeHtml()` for any user-generated content rendered as HTML to prevent XSS
- Keep DOM manipulation functions focused: one function per responsibility
- Use `data-` attributes on elements to store IDs instead of closure variables where possible

## Quick Improvements Checklist
- [ ] Disable send button while request is in flight
- [ ] Auto-focus textarea on page load and after each message
- [ ] Show "no conversations yet" empty state in sidebar
- [ ] Add timestamps to message bubbles (on hover or always visible)
- [ ] Add copy-to-clipboard button on code blocks in assistant messages
- [ ] Add a character/token estimate counter in the input bar
- [ ] Animate new messages sliding in with a subtle fade/translate
- [ ] Show agent "is typing..." with a pulsing dot indicator instead of inline "Thinking..."
