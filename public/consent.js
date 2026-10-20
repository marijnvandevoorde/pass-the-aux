// Google Tag Manager behind a cookie banner, with Google Consent Mode v2.
// Load it synchronously, first thing in <head>:  <script src="/consent.js"></script>
// and put a [data-consent-open] element anywhere to reopen the banner.
//
// - Every consent type defaults to 'denied' before GTM loads.
// - Accept grants analytics_storage only; the ad_* types stay denied.
// - The choice is kept in localStorage ('sv-consent'); Reject also removes GA cookies.
// - GTM_ID empty: nothing loads (no GTM, no banner).
// - The GA4 tag lives in the GTM container. Never push track, artist or
//   music-service data to the dataLayer, and keep page titles free of it.
(function () {
  var GTM_ID = 'GTM-TS9KWSKV';
  var PRIVACY_URL = '/privacy';
  var KEY = 'sv-consent';
  if (!GTM_ID) return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'denied',
    personalization_storage: 'denied',
    security_storage: 'denied',
    wait_for_update: 500,
  });

  function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  if (read() === 'granted') gtag('consent', 'update', { analytics_storage: 'granted' });

  window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
  var gtm = document.createElement('script');
  gtm.async = true;
  gtm.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(GTM_ID);
  var first = document.getElementsByTagName('script')[0];
  first.parentNode.insertBefore(gtm, first);

  // GA sets its cookies on the widest domain it can (e.g. .small-victories.co),
  // so clear them on the host and on every parent domain.
  function clearGaCookies() {
    var parts = location.hostname.split('.');
    var domains = [''];
    for (var i = 0; i < parts.length - 1; i++) {
      var d = parts.slice(i).join('.');
      domains.push('; domain=' + d, '; domain=.' + d);
    }
    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      if (name === '_ga' || name.indexOf('_ga_') === 0 || name === '_gid') {
        domains.forEach(function (d) {
          document.cookie = name + '=; Max-Age=0; path=/' + d;
        });
      }
    });
  }

  var CSS =
    '.consent{position:fixed;inset:auto 0 0 0;z-index:2147483000;background:#161a26;color:#eef1f8;' +
    'border-top:1px solid #2b3145;padding:16px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;' +
    'box-shadow:0 -10px 30px rgba(0,0,0,.55)}' +
    '.consent[hidden]{display:none}' +
    '.consent-inner{max-width:46rem;margin:0 auto}' +
    '.consent h2{font-size:15px;margin:0 0 4px}' +
    '.consent p{margin:0 0 12px;color:#8d95a9}' +
    '.consent a{color:#38e0c4}' +
    '.consent-actions{display:flex;gap:12px;flex-wrap:wrap}' +
    '.consent-actions button{font:inherit;font-weight:600;padding:7px 20px;border-radius:999px;' +
    'border:1px solid #38e0c4;background:transparent;color:#eef1f8;cursor:pointer}' +
    '.consent-actions button:focus-visible{outline:2px solid #38e0c4;outline-offset:2px}';

  function build() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var banner = document.createElement('section');
    banner.className = 'consent';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-labelledby', 'consent-title');
    banner.hidden = true;
    banner.innerHTML =
      '<div class="consent-inner">' +
      '<h2 id="consent-title">Cookies?</h2>' +
      '<p>Can we use Google Analytics to count visits? It sets cookies, and only if you say yes. ' +
      'More in the <a></a>.</p>' +
      '<div class="consent-actions">' +
      '<button type="button" data-consent="granted">Accept</button>' +
      '<button type="button" data-consent="denied">Reject</button>' +
      '</div></div>';
    var link = banner.querySelector('a');
    link.href = PRIVACY_URL;
    link.textContent = 'privacy policy';

    banner.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-consent]');
      if (!btn) return;
      var value = btn.getAttribute('data-consent');
      write(value);
      gtag('consent', 'update', { analytics_storage: value });
      if (value === 'denied') clearGaCookies();
      banner.hidden = true;
    });
    document.body.appendChild(banner);
    return banner;
  }

  function init() {
    var banner = build();
    var stored = read();
    if (stored !== 'granted' && stored !== 'denied') banner.hidden = false;
    document.addEventListener('click', function (e) {
      if (!e.target.closest('[data-consent-open]')) return;
      e.preventDefault();
      banner.hidden = false;
      banner.querySelector('button').focus();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
