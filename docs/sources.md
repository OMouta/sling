# Sources, files in chat, and the web

A personality can answer from three things beyond what its model knows: the web, files you give it for good, and files you attach to one message. Each answer cites what it used, as small numbered links next to the claims and a list of sources under the reply.

## Web search

Give a personality **Web search** under **What it can use**. It then searches when an answer depends on something current or that it's unsure of, opens the pages that matter, and cites them. Each search shows in the reply's steps with its query and results, and each page it opened with its site.

It uses the search the model already has, so Sling stores no search key:

| Model | Search |
|---|---|
| Claude Code on your machine | Its `WebSearch` and `WebFetch` tools, on your Claude subscription |
| Codex on your machine | Its live web search, on your ChatGPT subscription |
| An Anthropic API key | Anthropic's web search and web fetch tools, billed to that key |
| An OpenAI API key | OpenAI's web search tool, billed to that key |
| An OpenAI-compatible server, such as Ollama | None. The personality says search isn't available on this model |

What a page says is data. The assistant is told never to follow instructions it finds in a page or a search result.

The Sling, Ops, Incident, Research, Planner, Travel, and Finance templates come with Web search. Personalities you made from them before got it too, and you can turn it off on their page.

## Deep research

For a personality with Web search, on a model that can search, the **+** button in the composer has **Deep research**. With it on, a "Deep research" chip shows in the composer, and the next message runs as research: it plans the questions the answer needs, searches widely, opens the primary sources, and writes a report with a short answer first, then sections, then what's still uncertain. When the request is too broad, it asks up to three questions first.

While it works, the chat says "Researching" with how many searches and pages so far. A research turn may run up to 30 minutes on Claude Code or Codex, and up to 60 model steps on an API key. The switch turns off after sending, so the next message is a normal one.

## Sources on a personality

On a personality's page, **Sources** takes files and links that only that personality answers from: a course's lecture notes for a Tutor, a lease and the house manual for a home assistant.

- **Upload** or drop a PDF, a Word file (`.docx`), text, Markdown, CSV, JSON, or HTML. **Add link** takes a web page or a link to a PDF.
- Each one shows as processing, then with its pages or size once Sling has read it. A PDF with no text, such as a scan, fails with that reason, and so does one with a password. Sling doesn't read text in images.
- A personality takes up to 50 sources, each up to 25 MB.
- Remove one with its × button. It's gone from search right away.

The personality's prompt lists its sources by name. It searches them with `search_sources` before answering a question they might cover, and reads more with `read_source`. A citation opens the file, a PDF at the page it cites. Other personalities can't search them, an @mentioned one included.

A link is read once, when you add it. Sling fetches it from the server, refuses addresses on your own network (loopback, private, link-local, and cloud metadata addresses, checked again at every redirect), and stops at 25 MB, 20 seconds, or 5 redirects.

## Files in chat

Attach files to a message with **+ → Add files**, by dropping them anywhere on the chat or the new chat screen, or by pasting. Each shows as a chip above the text while it uploads, then with its name and pages. A message can carry up to 10 files, and can be sent with no text.

- **Documents** take the same kinds as sources. One under 20,000 characters goes to the model whole. A longer one is listed by name, and the model searches it with `search_sources`, as it does a personality's sources. The chat's documents stay searchable for the rest of the chat.
- **Images** (JPEG, PNG, WebP, GIF) are shrunk in your browser to 2,048 pixels on the long side before they upload, up to 4 per message and 3 MB in all. The model sees them on Claude Code, Codex, and both API keys. An OpenAI-compatible model sees them only if it takes images.

The sent message shows its files above the bubble: thumbnails that open full size, and chips that open the document.

## Where files are kept

Uploaded files and the text read from them live in Sling's Postgres, with the rest of the workspace, and go into your backups with it. Search is Postgres full-text search, with no embeddings and no other service. Files you attach and never send are cleared out once they're a day old.

All uploaded files together may take up to 1 GB, or what `SLING_SOURCE_STORAGE_BYTES` says (`0` for no limit). Settings → Storage shows how much is used, split into files sent in chats, personalities' sources, and files not sent yet. When it's full, an upload is refused until you remove sources from a personality or raise the limit.

Folders you share from a machine are different: their files stay on the machine, and Sling reads them there. See [memory.md](memory.md).
