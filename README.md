# @pipeworx/taiwan-companies

Taiwan's statutory company register (公司登記) — every incorporated company, its
統一編號, registered name, responsible person, capital, registered address and
current legal standing — from the Ministry of Economic Affairs' Department of
Commerce open-data service.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `twcompany_search_name(name, status?, limit?, offset?)` — search the register
  by company name (Chinese or partial).
- `twcompany_by_ban(ban)` — the full registration record for one 8-digit
  統一編號 (Business Administration Number).
- `twcompany_status(ban)` — normalized legal standing (registered / suspended /
  dissolved-or-revoked) with every register date converted from Minguo era.

## Auth

Keyless. No registration, no key, no published quota.

## Relationship to the other Taiwan packs

`taiwan-procurement` reads the public-tender bulletin (who won which government
contract) and `taiwan-stocks` reads TWSE/TPEx market data for the ~1,800 listed
issuers. This pack is the corporate register underneath both: it resolves a
統一編號 that appears in a tender award, and it covers the overwhelming majority
of Taiwanese companies, which are not listed anywhere.

## Data sources

- `https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6`
  — 公司登記基本資料 by 統一編號. Full record: capital, paid-in capital, par
  value, equity, address, registering authority, setup/amendment/revocation
  dates, suspension window.
- `https://data.gcis.nat.gov.tw/od/data/api/6BBA2268-1367-4B42-9CCA-BC17499EBE8C`
  — 公司登記基本資料 by 公司名稱. Name search only.

## Traps, all verified live 2026-09-17

Every one of these is a **silent zero** — HTTP 200 with an empty body — which is
the failure class nothing pages you about.

- **The name search REQUIRES a status filter.** `$filter=Company_Name like 台積電`
  alone returns HTTP 200 and zero bytes. Only
  `Company_Name like X and Company_Status eq NN` returns rows. No error, no hint.
- **Only three status codes exist**: `01` 核准設立 (registered/active),
  `04` 解散 (dissolved), `05` 撤銷 (revoked). `02`, `03`, `06`–`09` all answer
  with an empty body, indistinguishable from "no such company".
- **The two datasets are not interchangeable.** Each answers the other's query
  with an empty 200: `6BBA2268` ignores `Business_Accounting_NO`, `5F64D864`
  returns nothing for a `Company_Name like` filter.
- **The BAN dataset omits `Company_Status`** and returns only
  `Company_Status_Desc`, so any code-based mapping silently loses the status on
  exactly the lookup most callers use.
- **An unknown dataset id answers HTTP 200 with Chinese prose** —
  「此API不存在，請查明後繼續。」 — not a 404 and not JSON.
- **Dates are Minguo (ROC) era, zero-padded `YYYMMDD`.** `0760221` is
  1987-02-21 (076 + 1911); `1150821` is 2026-08-21. Read as a Gregorian integer
  it is off by 1,911 years and looks entirely plausible. Both forms are returned.
- `Capital_Stock_Amount` is **authorised** capital, `Paid_In_Capital_Amount` is
  what was actually paid in. For large issuers they differ by billions of TWD.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "taiwan-companies": {
      "url": "https://gateway.pipeworx.io/taiwan-companies/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/taiwan-companies/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/twcompany_search_name \
  -H 'Content-Type: application/json' \
  -d '{"name":"台積電","limit":3}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/twcompany_search_name`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-taiwan-companies` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/taiwan-companies/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "taiwan-companies": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-taiwan-companies"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Taiwan Companies data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
