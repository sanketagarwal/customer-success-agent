# Fixture personas

| Account | Story | Expected outcome |
| --- | --- | --- |
| `340739743463` | Strong adoption, resolved support, current billing, positive CSM note | `no_action` |
| `340734348989` | Adoption decline, urgent open ticket, past-due billing, negative CSM note | `awaiting_approval` |
| `340737895140` | Providers respond successfully but have no records | `insufficient_data` |
| `340878324429` | Support signal is unavailable, but the remaining account signals are healthy | `no_action` |

Dates are pinned so tests and demos remain deterministic. In HubSpot mode the
provider-neutral `accountId` values are replaced by real HubSpot company IDs.
