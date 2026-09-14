---
name: http
description: Make authenticated HTTP requests — POST, PUT, PATCH, DELETE — against REST and GraphQL APIs. Covers GitHub, Linear, Notion, Slack, and any service that accepts Bearer tokens or API keys. Auto-injected for researcher and coder role workers and triggered by API/integration keywords.
trigger: POST, REST, GraphQL, API key, Bearer, webhook, GitHub API, Linear, Notion, Slack, create issue, create PR, send message, HTTP request, authenticated, integration, endpoint
roles: coder, researcher, director, agent
requires_tools: fetch_url
---

## fetch_url — Full HTTP Client

`fetch_url` handles all HTTP methods, custom headers, and request bodies. Objects passed as `body` are JSON-serialised automatically; `Content-Type: application/json` is set unless overridden.

The response always includes `status` (HTTP status code) and `content` (parsed JSON object, or plain text). Check `status` — `2xx` is success; anything else has an `error` field and optional `body` with the error detail.

---

### GitHub REST API

```javascript
// Create an issue
fetch_url({
  url: "https://api.github.com/repos/OWNER/REPO/issues",
  method: "POST",
  headers: { "Authorization": "Bearer ghp_TOKEN", "X-GitHub-Api-Version": "2022-11-28" },
  body: { title: "Bug: login fails on Safari", body: "## Steps\n1. ...", labels: ["bug"], assignees: ["username"] }
})

// List open PRs
fetch_url({
  url: "https://api.github.com/repos/OWNER/REPO/pulls?state=open&per_page=20",
  headers: { "Authorization": "Bearer ghp_TOKEN", "X-GitHub-Api-Version": "2022-11-28" }
})

// Add a comment to an issue or PR
fetch_url({
  url: "https://api.github.com/repos/OWNER/REPO/issues/NUMBER/comments",
  method: "POST",
  headers: { "Authorization": "Bearer ghp_TOKEN", "X-GitHub-Api-Version": "2022-11-28" },
  body: { body: "Fixed in commit abc1234." }
})

// Update issue state (close)
fetch_url({
  url: "https://api.github.com/repos/OWNER/REPO/issues/NUMBER",
  method: "PATCH",
  headers: { "Authorization": "Bearer ghp_TOKEN", "X-GitHub-Api-Version": "2022-11-28" },
  body: { state: "closed" }
})
```

### GitHub GraphQL API

```javascript
// Search for files containing a pattern
fetch_url({
  url: "https://api.github.com/graphql",
  method: "POST",
  headers: { "Authorization": "Bearer ghp_TOKEN" },
  body: {
    query: `{ search(query: "repo:OWNER/REPO truncateResultForHistory", type: CODE, first: 5) {
      edges { node { ... on Blob { path repository { nameWithOwner } } } }
    } }`
  }
})
```

---

### Linear

```javascript
// Create an issue
fetch_url({
  url: "https://api.linear.app/graphql",
  method: "POST",
  headers: { "Authorization": "lin_api_TOKEN" },
  body: {
    query: `mutation {
      issueCreate(input: { teamId: "TEAM_ID", title: "Fix auth regression", priority: 2,
        description: "## Root cause\n...", labelIds: ["LABEL_ID"] }) {
        success
        issue { id identifier url }
      }
    }`
  }
})

// Transition issue state (e.g. mark In Progress)
fetch_url({
  url: "https://api.linear.app/graphql",
  method: "POST",
  headers: { "Authorization": "lin_api_TOKEN" },
  body: {
    query: `mutation { issueUpdate(id: "ISSUE_ID", input: { stateId: "STATE_ID" }) { success } }`
  }
})
```

---

### Slack

```javascript
// Post to an incoming webhook — no auth required, just the URL
fetch_url({
  url: "https://hooks.slack.com/services/T.../B.../...",
  method: "POST",
  body: {
    text: "Task complete",
    blocks: [{
      type: "section",
      text: { type: "mrkdwn", text: "*Deploy succeeded* — <https://github.com/...|view diff>" }
    }]
  }
})

// Post a message via Web API (requires OAuth token)
fetch_url({
  url: "https://slack.com/api/chat.postMessage",
  method: "POST",
  headers: { "Authorization": "Bearer xoxb-TOKEN" },
  body: { channel: "#dev", text: "Agent finished task 042." }
})
```

---

### Notion

```javascript
// Create a page in a database
fetch_url({
  url: "https://api.notion.com/v1/pages",
  method: "POST",
  headers: { "Authorization": "Bearer secret_TOKEN", "Notion-Version": "2022-06-28" },
  body: {
    parent: { database_id: "DATABASE_ID" },
    properties: {
      Name: { title: [{ text: { content: "Research: LCS algorithm" } }] },
      Status: { select: { name: "In Progress" } }
    }
  }
})

// Append a block to an existing page
fetch_url({
  url: "https://api.notion.com/v1/blocks/PAGE_ID/children",
  method: "PATCH",
  headers: { "Authorization": "Bearer secret_TOKEN", "Notion-Version": "2022-06-28" },
  body: {
    children: [{
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: "Finding: the fix is in llm-loops.js line 165." } }] }
    }]
  }
})
```

---

## Rules

- **Always check `status`** in the response. A `2xx` means success; `401` means the token is wrong or missing; `403` means the token lacks the required scope; `422` means the request body is malformed — read `body` for details.
- **API tokens come from the user** — ask if not provided. Never hardcode or guess tokens.
- **Do not log or store tokens** in workspace files or task notes. Reference them as `TOKEN` in plans.
- **Paginate when needed** — most APIs return 20–100 items by default; use `?page=N&per_page=100` (GitHub) or `first`/`after` cursor (GraphQL) for complete results.
- **Prefer PATCH over PUT** when updating a single field — PUT typically replaces the entire resource.
- **Respect rate limits** — GitHub: 5000 req/hr authenticated; Linear: 1500 req/hr; Notion: 3 req/s. If you get `429`, back off and retry after the `Retry-After` header value.
