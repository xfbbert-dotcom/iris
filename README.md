# Iris

Iris is the company's Feishu-native AI assistant and collaboration agent.

The architecture constitution lives at:

`docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

The first implementation slice builds:

- TypeScript Core App
- Feishu ack-first event ingestion
- runtime capability controls
- real-time permission guard
- context assembly with live chat anchoring
- Python AI worker job contracts

## Local Development

Install TypeScript dependencies:

```powershell
npm install
```

Run TypeScript tests:

```powershell
npm test
```

Run Python worker tests:

```powershell
cd workers/ai
python -m pytest
cd ../..
```

Start local infrastructure:

```powershell
docker compose up -d
```
