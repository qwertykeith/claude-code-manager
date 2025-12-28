# Security Policy

## Threat Model

Claude Manager is a **local development tool** designed to run exclusively on `localhost`. It is NOT intended for:

- Network deployment
- Multi-user environments
- Production servers
- Untrusted machines

### Security Boundaries

1. **Network**: Server binds to `127.0.0.1` only - not accessible from other machines
2. **Authentication**: None - assumes single trusted user on local machine
3. **Authorization**: None - all sessions accessible to any local browser tab

## Known Security Considerations

### Environment Variable Inheritance

When spawning terminal sessions, Claude Manager passes the parent process's environment to the shell. This is intentional for Claude CLI to function correctly, but means:

- API keys in your environment (e.g., `ANTHROPIC_API_KEY`) are accessible in spawned sessions
- Any sensitive environment variables are inherited

**Recommendation**: Only run Claude Manager in environments where you trust the spawned shell to have access to your environment.

### Terminal Content Exposure

All terminal output is:
- Stored in memory (not persisted to disk)
- Transmitted over plain WebSocket to localhost
- Visible to any browser tab on the same machine

**Recommendation**: Do not type sensitive credentials directly into Claude sessions.

### File System Access

Claude Manager reads from:
- `~/.claude/projects/` - for usage statistics (read-only)
- `./public/` - for serving static files (read-only)

No writes are made to user directories.

## Security Measures Implemented

1. **Path Traversal Prevention**: Static file serving validates paths stay within public directory
2. **Localhost Binding**: Server explicitly binds to `127.0.0.1`
3. **Input Validation**: WebSocket messages are validated for type and format
4. **Command Injection Prevention**: External commands use `spawn()` with argument arrays, not shell interpolation
5. **Buffer Limits**: Terminal output buffers capped at 1MB
6. **Subprocess Timeouts**: AI summarization has 15-second timeout

## Reporting Vulnerabilities

If you discover a security vulnerability, please:

1. **Do NOT open a public issue**
2. Email the maintainer directly or use GitHub's private vulnerability reporting
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We aim to respond within 48 hours and will credit reporters in release notes (unless anonymity is requested).

## Version History

| Version | Security Notes |
|---------|---------------|
| 1.0.0   | Initial release with security hardening |
