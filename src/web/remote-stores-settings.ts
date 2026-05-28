import { api } from "./api.js";
import type {
  RemoteStoreInput,
  RemoteStoreKind,
  RemoteStorePublic,
} from "./types.js";

/** Settings → Remote record stores: list/add/edit/delete/setActive.
 *  The HTTP layer is already exposed at /api/remote/sources +
 *  /api/remote/active; this just paints the UI inside the Settings modal.
 *
 *  Editing a row reuses the add form: `editingId` distinguishes the modes.
 *  Whenever the list changes, `onChange()` fires so app.ts can refresh
 *  `remoteEnabled` (which controls the extended-search overlay). */
export class RemoteStoresSettings {
  readonly #onChange: () => void;
  readonly #group = q<HTMLElement>("#remote-stores-group");
  readonly #locked = q<HTMLElement>("#remote-stores-locked");
  readonly #list = q<HTMLUListElement>("#remote-stores-list");
  readonly #empty = q<HTMLElement>("#remote-stores-empty");
  readonly #addBtn = q<HTMLButtonElement>("#remote-stores-add");
  readonly #form = q<HTMLFormElement>("#remote-stores-form");
  readonly #formTitle = q<HTMLElement>("#remote-stores-form-title");
  readonly #kind = q<HTMLSelectElement>("#rs-kind");
  readonly #name = q<HTMLInputElement>("#rs-name");
  readonly #baseField = q<HTMLElement>(".rs-field-base");
  readonly #base = q<HTMLInputElement>("#rs-base");
  readonly #key = q<HTMLInputElement>("#rs-key");
  readonly #keyHint = q<HTMLElement>("#rs-key-hint");
  readonly #cancel = q<HTMLButtonElement>("#rs-cancel");
  readonly #error = q<HTMLElement>("#rs-error");

  /** Currently shown rows (last fetch). */
  #rows: RemoteStorePublic[] = [];
  /** Whether the account's plan allows managing remote stores. Free
   *  accounts can't — the section is grayed out and add is blocked. */
  #canManage = true;
  /** id of the row being edited, or null when adding. */
  #editingId: string | null = null;
  /** Cleared on every successful load; populated when the UI first
   *  opens, so we don't refetch on every Settings open. */
  #loaded = false;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
    this.#addBtn.onclick = () => this.#openForm(null);
    this.#cancel.onclick = () => this.#closeForm();
    this.#kind.onchange = () => this.#syncKindFields();
    this.#form.onsubmit = (e) => {
      e.preventDefault();
      void this.#submit();
    };
  }

  /** Called once when the Settings modal is opened for the first time
   *  in a session. Subsequent opens reuse the in-memory list. */
  async ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const { items, canManage } = await api.remoteStores.list();
      this.#rows = items;
      this.#canManage = canManage;
      this.#loaded = true;
      this.#render();
    } catch {
      // List failed — likely not logged in. The modal still works
      // for audio settings; surface a minimal placeholder.
      this.#rows = [];
      this.#list.innerHTML = "";
      this.#empty.hidden = false;
      this.#empty.textContent = "Could not load remote stores.";
    }
  }

  #render(): void {
    // Free plan: lock the whole section — no add, no upsell-less empty
    // hint, just a clear "this is a paid feature" note.
    this.#group.classList.toggle("is-locked", !this.#canManage);
    this.#locked.hidden = this.#canManage;
    if (!this.#canManage) this.#closeForm(); // re-shows addBtn; hide it next
    this.#addBtn.hidden = !this.#canManage;

    this.#list.innerHTML = "";
    this.#empty.hidden = !this.#canManage || this.#rows.length > 0;
    for (const row of this.#rows) {
      this.#list.appendChild(this.#renderRow(row));
    }
  }

  #renderRow(row: RemoteStorePublic): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "rs-item" + (row.isActive ? " is-active" : "");

    const main = document.createElement("div");
    main.className = "rs-item-main";
    const nameEl = document.createElement("div");
    nameEl.className = "rs-item-name";
    nameEl.textContent = row.name;
    if (row.isActive) {
      const badge = document.createElement("span");
      badge.className = "rs-badge";
      badge.textContent = "active";
      nameEl.appendChild(badge);
    }
    const metaEl = document.createElement("div");
    metaEl.className = "rs-item-meta";
    metaEl.textContent =
      KIND_LABEL[row.kind] +
      (row.baseUrl !== null ? ` · ${row.baseUrl}` : "");
    main.appendChild(nameEl);
    main.appendChild(metaEl);

    const actions = document.createElement("div");
    actions.className = "rs-item-actions";
    if (!row.isActive) {
      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "rs-use";
      useBtn.textContent = "Use";
      useBtn.onclick = () => void this.#setActive(row.id);
      actions.appendChild(useBtn);
    }
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "rs-edit";
    editBtn.textContent = "Edit";
    editBtn.onclick = () => this.#openForm(row);
    actions.appendChild(editBtn);
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "rs-del";
    delBtn.title = "Remove";
    delBtn.setAttribute("aria-label", "Remove");
    delBtn.textContent = "×";
    delBtn.onclick = () => void this.#remove(row);
    actions.appendChild(delBtn);

    li.appendChild(main);
    li.appendChild(actions);
    return li;
  }

  #openForm(editing: RemoteStorePublic | null): void {
    this.#editingId = editing?.id ?? null;
    this.#formTitle.textContent =
      editing === null
        ? "Add remote record store"
        : `Edit “${editing.name}”`;
    this.#kind.value = editing?.kind ?? "pta";
    this.#kind.disabled = editing !== null; // changing kind in-place is messy
    this.#name.value = editing?.name ?? "";
    this.#base.value = editing?.baseUrl ?? "";
    // Existing key is never returned by the server. Leaving the field
    // blank in edit mode means "keep current key".
    this.#key.value = "";
    this.#key.placeholder = editing === null ? "" : "(unchanged)";
    this.#syncKindFields();
    this.#error.hidden = true;
    this.#error.textContent = "";
    this.#form.hidden = false;
    this.#addBtn.hidden = true;
    this.#name.focus();
  }

  #closeForm(): void {
    this.#editingId = null;
    this.#form.hidden = true;
    this.#addBtn.hidden = false;
    this.#error.hidden = true;
  }

  /** Kind drives which fields are shown + the hint text. */
  #syncKindFields(): void {
    const kind = this.#kind.value as RemoteStoreKind;
    const showBase = kind === "pta";
    this.#baseField.hidden = !showBase;
    // Toggle the kind-specific halves of the key label.
    this.#form.dataset["kind"] = kind;
    this.#keyHint.textContent = KEY_HINT[kind] ?? "";
  }

  async #submit(): Promise<void> {
    const kind = this.#kind.value as RemoteStoreKind;
    const name = this.#name.value.trim();
    const baseUrl = this.#base.value.trim() || null;
    const apiKey = this.#key.value.trim() || null;

    try {
      if (this.#editingId === null) {
        const input: RemoteStoreInput = { kind, name, baseUrl, apiKey };
        await api.remoteStores.add(input);
      } else {
        // Edit: only send apiKey when the user typed a new value, so
        // we don't overwrite the stored key with null.
        const patch: Partial<RemoteStoreInput> = { name, baseUrl };
        if (apiKey !== null) patch.apiKey = apiKey;
        await api.remoteStores.update(this.#editingId, patch);
      }
      this.#closeForm();
      await this.refresh();
      this.#onChange();
    } catch (e) {
      this.#error.hidden = false;
      this.#error.textContent = e instanceof Error ? e.message : "Save failed";
    }
  }

  async #setActive(id: string): Promise<void> {
    try {
      await api.remoteStores.setActive(id);
      await this.refresh();
      this.#onChange();
    } catch {
      // Keep the UI sane on failure: a refresh still reflects truth.
      await this.refresh();
    }
  }

  async #remove(row: RemoteStorePublic): Promise<void> {
    if (!window.confirm(`Remove “${row.name}”?`)) return;
    try {
      await api.remoteStores.remove(row.id);
      await this.refresh();
      this.#onChange();
    } catch {
      await this.refresh();
    }
  }
}

const KIND_LABEL: Record<RemoteStoreKind, string> = {
  pta: "Pass the Aux",
  jamendo: "Jamendo",
  fma: "Free Music Archive",
};

const KEY_HINT: Partial<Record<RemoteStoreKind, string>> = {
  pta: "Matches PTA_SECRET on the pass-the-remote server.",
  jamendo: "Free client_id from developer.jamendo.com.",
};

function q<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector(sel);
  if (el === null) throw new Error(`missing element: ${sel}`);
  return el as T;
}
