export interface TrackProps {
  id: string;
  name: string;
  dir: string;
  ext: string;
  size: number;
  mtime: number;
  bpm: number | null;
  title?: string | null;
  artist?: string | null;
  key?: string | null;
  mode?: string | null;
  camelot?: string | null;
  energy?: number | null;
}

/** A track in the library. Identity is its library-relative path (`id`). */
export class Track {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
  readonly ext: string;
  readonly size: number;
  readonly mtime: number;
  readonly bpm: number | null;
  readonly title: string | null;
  readonly artist: string | null;
  readonly key: string | null;
  readonly mode: string | null;
  readonly camelot: string | null;
  readonly energy: number | null;

  constructor(props: TrackProps) {
    this.id = props.id;
    this.name = props.name;
    this.dir = props.dir;
    this.ext = props.ext;
    this.size = props.size;
    this.mtime = props.mtime;
    this.bpm = props.bpm;
    this.title = props.title ?? null;
    this.artist = props.artist ?? null;
    this.key = props.key ?? null;
    this.mode = props.mode ?? null;
    this.camelot = props.camelot ?? null;
    this.energy = props.energy ?? null;
  }

  withBpm(bpm: number | null): Track {
    return new Track({ ...this.#props(), bpm });
  }

  withTags(title: string | null, artist: string | null): Track {
    return new Track({ ...this.#props(), title, artist });
  }

  withAnalysis(a: {
    bpm: number | null;
    key?: string | null;
    mode?: string | null;
    camelot?: string | null;
    energy?: number | null;
  }): Track {
    return new Track({
      ...this.#props(),
      bpm: a.bpm,
      key: a.key ?? null,
      mode: a.mode ?? null,
      camelot: a.camelot ?? null,
      energy: a.energy ?? null,
    });
  }

  #props(): TrackProps {
    return {
      id: this.id,
      name: this.name,
      dir: this.dir,
      ext: this.ext,
      size: this.size,
      mtime: this.mtime,
      bpm: this.bpm,
      title: this.title,
      artist: this.artist,
      key: this.key,
      mode: this.mode,
      camelot: this.camelot,
      energy: this.energy,
    };
  }

  /** Human-facing label: "Artist — Title" from tags, else title, else file. */
  get display(): string {
    if (this.artist && this.title) return `${this.artist} — ${this.title}`;
    return this.title ?? this.name;
  }

  /** Wire format. `path` is kept as an alias of `id` for the existing client. */
  toJSON() {
    return {
      id: this.id,
      path: this.id,
      name: this.name,
      display: this.display,
      dir: this.dir,
      ext: this.ext,
      size: this.size,
      mtime: this.mtime,
      bpm: this.bpm,
      title: this.title,
      artist: this.artist,
      key: this.key,
      mode: this.mode,
      camelot: this.camelot,
      energy: this.energy,
    };
  }
}
