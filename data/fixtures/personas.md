# Fixture personas

| Account | Story | Expected outcome |
| --- | --- | --- |
| `company-healthy` | Strong adoption, resolved support, current billing, positive CSM note | `no_action` |
| `company-declining` | Adoption decline, urgent open ticket, past-due billing, negative CSM note | `awaiting_approval` |
| `company-insufficient` | Providers respond successfully but have no records | `insufficient_data` |
| `company-provider-down` | Support provider returns a transport outage | `unknown_retry` |

Dates are pinned so tests and demos remain deterministic. In HubSpot mode the
provider-neutral `accountId` values are replaced by real HubSpot company IDs.
