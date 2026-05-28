import { RemoteLibrarySource } from "./remote-library-source.ts";
import { JamendoSource } from "./jamendo-source.ts";
import type { RemoteSource } from "../domain/ports/remote-source.ts";
import type { RemoteLibraryRow } from "../domain/ports/remote-libraries-repository.ts";

/** Translates a stored remote-library row into a runtime `RemoteSource`.
 *  Returns `null` for kinds that don't have an adapter yet (only FMA,
 *  whose public API was retired). */
export function buildRemoteSource(row: RemoteLibraryRow): RemoteSource | null {
  switch (row.kind) {
    case "pta":
      return new RemoteLibrarySource({
        id: row.id,
        displayName: row.name,
        baseUrl: row.baseUrl,
        secret: row.apiKey,
      });
    case "jamendo":
      return new JamendoSource({
        id: row.id,
        displayName: row.name,
        clientId: row.apiKey,
      });
    case "fma":
      // FMA's public API was retired (2022). Adapter would go here.
      return null;
  }
}
