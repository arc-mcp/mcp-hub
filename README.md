# arc-mcp-hub — retired

> **Superseded by [ARC-1's Multi-System Setup](https://docs.arc-1-mcp.com/multi-target-setup/).**
> This project is retired and retained for historical reference. No further features, bug fixes,
> dependency updates, or security fixes are planned. Use ARC-1 for new SAP multi-system deployments.

The hub originally placed several ARC-1 instances behind one MCP host, with a separate application
for routing and token exchange. ARC-1 now handles SAP system/client routing directly through its
built-in multi-target mode, removing the need for this hub in that deployment model.

## Move to ARC-1

Start with the [migration guide](docs/migration-to-arc-1.md), then follow the maintained ARC-1 docs:

- [BTP deployment overview](https://docs.arc-1-mcp.com/btp-overview/) — choose the topology.
- [Multi-System Setup](https://docs.arc-1-mcp.com/multi-target-setup/) — deploy and configure targets.
- [Multi-Target Administration](https://docs.arc-1-mcp.com/multi-target-administration/) — operate the service.
- [ARC-1 repository](https://github.com/arc-mcp/arc-1) — maintained code and issue tracker.

| Former hub interface | ARC-1 multi-target interface |
|---|---|
| `https://<hub>/dev/mcp` | `https://<arc1-route>/<SYSTEM>/<CLIENT>/mcp`, for example `/A4H/001/mcp` |
| `https://<hub>/all/mcp` with `system: "dev"` | `https://<arc1-route>/multi/mcp` with `target: "A4H/001"` |
| `HUB_BACKENDS` pointing to ARC-1 MCP backends | Marked BTP subaccount destinations pointing to SAP systems |

Map each old environment name to its actual SAP system/client; these examples are not automatic
aliases. Update client URLs and prompts/tool calls, then authenticate against ARC-1.

**Check the replacement's scope before migrating:** multi-target v1 is experimental, default-off,
and mutation-free. It runs on SAP BTP Cloud Foundry with XSUAA and on-premise SAP targets.
Principal Propagation is recommended. Shared Basic authentication is a separate opt-in with a
one-instance limit. Writes, activation, and transport/Git mutations are unavailable on multi-target
routes. Use separate ARC-1 instances and direct MCP connections for writable access or stronger
isolation. Other MCP server backends need their own direct connections; ARC-1 is not a general proxy.

## Historical material

The source, tests, and deployment files are retained to explain existing installations. The following
documents describe the former hub and are not instructions for new deployments:

- [Previous README](docs/legacy-readme.md)
- [Architecture](docs/architecture.md)
- [Operator setup](docs/operator-setup.md)
- [MCP server integration](docs/integrating-an-mcp-server.md)
- [Closed roadmap](docs/roadmap.md)
- [Original implementation record](docs/plans/build-arc-mcp-hub.md)

Repository archival does not stop a deployed hub or migrate its users. Existing operators should
follow the [cutover and retirement steps](docs/migration-to-arc-1.md#cut-over-an-existing-installation).

## License

MIT
