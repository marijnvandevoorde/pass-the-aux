/* Tweaks panel — drives the vanilla CSS variables on :root */
const { useEffect } = React;

const ACCENTS = {
  Mint:   { a: '#38e0c4', b: '#2bd0d6', ink: '#04201b', glow: 'rgba(56,224,196,0.35)' },
  Violet: { a: '#b388ff', b: '#8e7bff', ink: '#16092e', glow: 'rgba(179,136,255,0.35)' },
  Coral:  { a: '#ff7a59', b: '#ff5d8f', ink: '#2a0c08', glow: 'rgba(255,122,89,0.35)' },
  Azure:  { a: '#4aa8ff', b: '#5ec8ff', ink: '#05182e', glow: 'rgba(74,168,255,0.35)' },
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "Mint",
  "cover": "vinyl",
  "density": "regular",
  "showWho": true
}/*EDITMODE-END*/;

function applyTweaks(t) {
  const root = document.documentElement;
  const ac = ACCENTS[t.accent] || ACCENTS.Mint;
  root.style.setProperty('--accent', ac.a);
  root.style.setProperty('--accent-2', ac.b);
  root.style.setProperty('--accent-ink', ac.ink);
  root.style.setProperty('--accent-glow', ac.glow);
  root.dataset.cover = t.cover;
  root.dataset.density = t.density;
  root.classList.toggle('hide-who', !t.showWho);
}

function TweaksApp() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  useEffect(() => { applyTweaks(t); }, [t]);

  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="Identity" />
      <TweakRadio label="Accent" value={t.accent}
        options={['Mint', 'Violet', 'Coral', 'Azure']}
        onChange={(v) => setTweak('accent', v)} />
      <TweakRadio label="Cover" value={t.cover}
        options={['vinyl', 'gradient']}
        onChange={(v) => setTweak('cover', v)} />

      <TweakSection label="Queue" />
      <TweakRadio label="Density" value={t.density}
        options={['compact', 'regular', 'cozy']}
        onChange={(v) => setTweak('density', v)} />
      <TweakToggle label="Show who added" value={t.showWho}
        onChange={(v) => setTweak('showWho', v)} />
    </TweaksPanel>
  );
}

ReactDOM.createRoot(document.getElementById('tweaks-root')).render(<TweaksApp />);
