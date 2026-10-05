# Migrate from mcp-hub to ARC-1

The hub is retired. Its SAP multi-system use case is now handled inside
[ARC-1](https://github.com/arc-mcp/arc-1). This guide maps the former hub concepts to the replacement;
the linked ARC-1 guides own the deployment commands and current configuration contract. Use the
documentation from the source revision used to build your ARC-1 deployment.

## Choose the replacement

| Existing use | Replacement |
|---|---|
| Read access to several on-premise SAP systems/clients | ARC-1 multi-target mode on BTP Cloud Foundry: pinned routes or `/multi/mcp` |
| Writes, activation, or transport/Git mutations | Separate ARC-1 instances with direct MCP connections and independently configured permissions |
| Restricted target visibility or separate failure/security boundaries | Separate ARC-1 instances; a pinned URL is not a target-specific authorization boundary |
| BTP ABAP Environment or S/4HANA Public Cloud | Use the dedicated single-target deployment described in the [BTP overview](https://docs.arc-1-mcp.com/btp-overview/) |
| Other MCP servers formerly behind the hub | Connect to those servers directly using their supported authentication; ARC-1 does not proxy arbitrary MCP backends |

Multi-target v1 is **experimental, default-off, and mutation-free**. It does not preserve the hub's
ability to relay every backend tool unchanged. Data preview and SQL are separate opt-ins. ATC and
ABAP Unit are available diagnostics but execute SAP workloads. Read the
[available tool/action contract](https://docs.arc-1-mcp.com/multi-target-setup/#what-multi-target-v1-exposes)
before moving a workflow.

## Translate routing and configuration

| Hub | ARC-1 multi-target |
|---|---|
| `HUB_BACKENDS[].name`, such as `dev` | Public target ID derived from the real `sap-sysid` and `sap-client`, such as `A4H/001` |
| `/<env>/mcp` | `/<SYSTEM>/<CLIENT>/mcp`; no `target` argument on this pinned connection |
| `/all/mcp` and a required `system` argument | `/multi/mcp` and a required `target` argument on SAP-contacting calls |
| `HUB_ALL_ENDPOINT=true` | `ARC1_MULTI_TARGET_ENDPOINTS=true` enables both pinned and aggregate routes |
| `HUB_BACKENDS` with `OAuth2JWTBearer` destinations to MCP backends | Subaccount destinations to SAP, marked `arc1.enabled=true`; not destinations to backend `/mcp` URLs |
| Hub foreign-scope grants and role collections | ARC-1's own XSUAA roles plus the selected SAP identity's authorization |

There is no automatic import of `HUB_*` or `ARC_HUB_*` settings, environment names, OAuth
registrations, or sessions. Record an explicit old-name-to-target mapping. For example, a call to
the former aggregate endpoint with `system: "dev"` becomes a call to `/multi/mcp` with
`target: "A4H/001"` only if `dev` actually referred to that SAP system/client. Remove the old
`system` argument. When independent systems share a SID/client, use the documented `arc1.target_alias`
property while retaining truthful `sap-sysid` and `sap-client` values.

For a new installation, begin with
[BTP Cloud Foundry Deployment](https://docs.arc-1-mcp.com/btp-cloud-foundry-deployment/), then follow
[Multi-System Setup](https://docs.arc-1-mcp.com/multi-target-setup/). The multi-target override requires
`ARC1_MULTI_TARGET_ENDPOINTS=true` and `ARC1_CACHE=none`, alongside the documented XSUAA bindings,
standard tools, disabled UI/plugins, and mutation ceilings. Configure durable CF settings in the
deployment's `.mtaext`; the old hub manifest is not an ARC-1 deployment template.

Principal Propagation keeps the SAP identity per user and is the recommended path. Shared Basic
authentication requires the separate `ARC1_MULTI_TARGET_ALLOW_BASIC_AUTH=true` opt-in, approved
technical-user destinations, and exactly one CF app instance with non-rolling deployment. It never
acts as fallback for failed Principal Propagation. Follow the identity-specific setup and acceptance
checks instead of carrying over the hub's token-exchange configuration.

Multi-target roles are global: an ARC-1 read user can attempt every accepted target. SAP authorization
applies to the propagated user or the explicitly shared technical user. The old per-backend role
arrangement does not become per-target access control. Use separate instances if that separation or
hidden target inventory is required.

## Cut over an existing installation

1. Inventory each hub route, backend, SAP system/client, identity model, permission set, and client
   connection. Identify workflows that require a separate ARC-1 instance. Retain the current hub
   configuration and deployment artifact for rollback in the operator's secure configuration store.
2. Deploy the replacement and configure its destinations, Cloud Connector mappings, and ARC-1 role
   collections using the maintained guides. Do not overwrite the hub's destinations during staging.
3. Verify discovery with an Admin connection to `/multi/mcp` and `SAPTargets`. For every target, use
   a freshly authenticated representative user to run the guide's safe-read acceptance checks,
   confirm the expected SAP identity, and check the permitted tool surface. Validate data/SQL only
   if enabled. A healthy HTTP endpoint alone does not prove target access.
4. Update client URLs, saved prompts, and integrations. Replace aggregate `system` arguments with
   `target`; pinned calls need neither. Establish new OAuth registrations/sessions against ARC-1
   and verify the workflows again from the actual clients. Retain the old connection details until
   acceptance is complete so clients can be switched back if needed.
5. Once all users have moved and the agreed rollback window has ended, retire the deployed hub.
   The responsible operators should remove only hub-exclusive routes, destinations, role
   collections, foreign-scope grants, bindings, service keys, and service instances after checking
   consumers. Preserve shared Destination/XSUAA services and any ARC-1 backends still serving users.

Repository archival is separate from deployment retirement: it does not shut down CF applications,
revoke credentials, or redirect MCP clients.

## Finish repository archival

After merging the retirement change into the default branch:

- Set the GitHub repository description to `Retired MCP hub for SAP BTP; superseded by ARC-1 multi-system setup.`
  and the homepage to [Multi-System Setup](https://docs.arc-1-mcp.com/multi-target-setup/).
- Resolve or explicitly defer any remaining open issues and pull requests before making the repository
  read-only. Do not transfer the historical roadmap wholesale into ARC-1's idea roadmap.
- Archive `arc-mcp/mcp-hub` in GitHub. Keep its history, branches, and deployment references available.

The repository's CI runs only on pushes to `main` and pull requests; it has no scheduled or publishing
workflow to retire. Leave validation available for the final PR. The package is marked `private: true`;
no npm publication or new release is needed for this documentation change.
