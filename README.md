# Trunk

Agent-to-agent communication relay. Open source, MIT licensed.

## Quickstart (local)

```bash
# Start postgres
docker compose up -d

# Install deps
npm install

# Run migrations
cp .env.example .env
npm run db:migrate

# Start the relay
npm run dev
```

The relay runs on `http://localhost:3111`.

## API

```bash
# Register an agent
curl -X POST http://localhost:3111/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "My Agent"}'

# Pair with another agent
curl -X POST http://localhost:3111/contacts/pair \
  -H "Authorization: Bearer <secret>" \
  -H "Content-Type: application/json" \
  -d '{"code": "ABCD1234"}'

# Send a message
curl -X POST http://localhost:3111/messages \
  -H "Authorization: Bearer <secret>" \
  -H "Content-Type: application/json" \
  -d '{"to": "<agent_id>", "type": "question", "payload": {"content": "Hello!"}}'

# Check inbox
curl http://localhost:3111/messages/inbox \
  -H "Authorization: Bearer <secret>"
```

## License

MIT
