import { useEffect, useRef, useState } from 'react';
import { Search, X, ImageOff, ArrowUpRight } from 'lucide-react';
import type { GifProvidersResponse, GifSearchPage, GifSearchResult } from '@tricord/shared';
import {
  buildGiphySearchUrl,
  parseGiphySearchPage,
  buildKlipySearchUrl,
  parseKlipySearchPage,
} from '@tricord/shared';
import { useAuth } from './Auth';
import './gif-search.css';
import giphyAttribution from './assets/powered-by-giphy.png';

type SearchProvider = 'giphy' | 'klipy';
async function fetchProviderPage(
  provider: SearchProvider,
  key: string,
  query: string,
  cursor: string | null,
  signal: AbortSignal,
) {
  const label = provider === 'klipy' ? 'KLIPY' : 'GIPHY';
  const buildUrl = provider === 'klipy' ? buildKlipySearchUrl : buildGiphySearchUrl;
  const response = await fetch(buildUrl(key, query, cursor ?? undefined), {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    signal,
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? label + ' is busy. Wait a moment and retry.'
        : label + ' could not complete this search.',
    );
  if (!response.headers.get('content-type')?.includes('application/json') || !response.body)
    throw new Error(label + ' returned an unsupported response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new Error('The GIF search response was too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new Error(label + ' returned an invalid response.');
  }
  return provider === 'klipy'
    ? parseKlipySearchPage(body, cursor ?? undefined)
    : parseGiphySearchPage(body, cursor ?? undefined);
}
export const fetchGiphyPage = (
  key: string,
  query: string,
  cursor: string | null,
  signal: AbortSignal,
) => fetchProviderPage('giphy', key, query, cursor, signal);
export const fetchKlipyPage = (
  key: string,
  query: string,
  cursor: string | null,
  signal: AbortSignal,
) => fetchProviderPage('klipy', key, query, cursor, signal);

export function GifSearch({
  open,
  onClose,
  onSend,
  onDismiss,
}: {
  open: boolean;
  onClose: () => void;
  onSend: (url: string) => Promise<void>;
  onDismiss?: () => void;
}) {
  const { request } = useAuth();
  const requestRef = useRef(request);
  requestRef.current = request;
  const [providers, setProviders] = useState<GifProvidersResponse['providers']>([]);
  const [provider, setProvider] = useState<SearchProvider>('giphy');
  const providerName = provider === 'klipy' ? 'KLIPY' : 'GIPHY';
  const [query, setQuery] = useState(''),
    [committed, setCommitted] = useState('');
  const [consent, setConsent] = useState(false),
    [revision, setRevision] = useState(0);
  const [page, setPage] = useState<GifSearchPage | null>(null),
    [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState(''),
    [configBusy, setConfigBusy] = useState(true);
  const [configError, setConfigError] = useState(false),
    [configVersion, setConfigVersion] = useState(0);
  const [failedPreviews, setFailedPreviews] = useState(new Set<string>());
  const generation = useRef(0),
    input = useRef<HTMLInputElement>(null);
  const selected = providers.find((entry) => entry.id === provider);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const controller = new AbortController();
    setConfigBusy(true);
    setConfigError(false);
    void requestRef
      .current<GifProvidersResponse>('/gifs/providers', 'GET', undefined, controller.signal)
      .then((result) => {
        setProviders(result.providers);
        setProvider((previous) => {
          if (result.providers.some((entry) => entry.id === previous && entry.enabled))
            return previous;
          return result.providers.some((entry) => entry.id === 'klipy' && entry.enabled)
            ? 'klipy'
            : 'giphy';
        });
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) {
          setConfigError(true);
          setError(cause.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setConfigBusy(false);
      });
    return () => controller.abort();
  }, [open, configVersion]);
  useEffect(() => {
    if (!consent || !open || query === committed) return;
    const timer = setTimeout(() => {
      setCommitted(query);
      setCursor(null);
    }, 300);
    return () => clearTimeout(timer);
  }, [consent, open, query, committed]);
  useEffect(() => {
    if (!open || !consent || committed.trim().length < 2 || !selected?.enabled) return;
    const controller = new AbortController();
    const version = ++generation.current;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]);
    setBusy(true);
    setError('');
    setPage(null);
    void (async () => {
      if (!('publicKey' in selected) || typeof selected.publicKey !== 'string')
        throw new Error(providerName + ' search has not been configured.');
      return fetchProviderPage(provider, selected.publicKey, committed, cursor, signal);
    })()
      .then((result) => {
        if (version === generation.current) {
          setPage(result);
          setFailedPreviews(new Set());
        }
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted && version === generation.current)
          setError(signal.aborted ? 'GIF search timed out. Try again.' : cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted && version === generation.current) setBusy(false);
      });
    return () => {
      controller.abort();
      generation.current++;
    };
  }, [open, consent, committed, cursor, selected, revision, provider, providerName]);
  async function send(item: GifSearchResult) {
    if (sending) return;
    setSending(item.id);
    setError('');
    try {
      await onSend(item.url);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSending(null);
    }
  }
  return (
    <section
      className="gif-search-panel animated-surface"
      role="dialog"
      aria-label="Search GIFs"
      data-open={open}
      inert={!open}
      aria-hidden={!open}
      onBlur={(event) => {
        const target = event.relatedTarget;
        if (
          target instanceof Element &&
          !event.currentTarget.contains(target) &&
          !target.closest('button[aria-label="Search GIFs"]')
        )
          onDismiss?.();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <div>
          <strong>Say it with a GIF.</strong>
          <small>Pick one to send. Your draft stays here.</small>
        </div>
        <button
          type="button"
          className="surface-close"
          aria-label="Close GIF search"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      <div className="gif-provider-tabs" role="tablist" aria-label="GIF providers">
        <span
          className="gif-provider-indicator"
          aria-hidden="true"
          style={{ transform: provider === 'klipy' ? 'translateX(100%)' : 'none' }}
        />
        {(['giphy', 'klipy'] as const).map((value) => (
          <button
            type="button"
            role="tab"
            key={value}
            aria-selected={provider === value}
            disabled={sending !== null}
            onClick={() => {
              if (value === provider) return;
              generation.current++;
              setProvider(value);
              setCursor(null);
              setPage(null);
              setBusy(false);
              setError('');
              setConsent(false);
              setCommitted('');
              requestAnimationFrame(() => input.current?.focus());
            }}
          >
            {value === 'klipy' ? 'KLIPY' : 'GIPHY'}
          </button>
        ))}
      </div>
      <div className="gif-search-stage">
        <form
          className="gif-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selected?.enabled) return;
            if (query.trim().length < 2) {
              setError('Type at least two characters to search.');
              return;
            }
            setConsent(true);
            setCommitted(query);
            setCursor(null);
            setRevision((value) => value + 1);
          }}
        >
          <Search size={17} aria-hidden="true" />
          <input
            ref={input}
            type="search"
            aria-label="Search GIFs"
            placeholder={'Search ' + providerName}
            value={query}
            maxLength={provider === 'klipy' ? 80 : 50}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="submit"
            disabled={!selected?.enabled || sending !== null}
            aria-label="Run GIF search"
          >
            Search
          </button>
        </form>
        {configBusy ? (
          <p role="status">Checking GIF providers…</p>
        ) : !configError && !selected?.enabled ? (
          <div className="gif-search-empty">
            <ImageOff size={25} />
            <strong>{providerName} is not configured</strong>
            <p>
              The server owner needs to add the {providerName} API key. No search terms have been
              sent.
            </p>
          </div>
        ) : !consent ? (
          <div className="gif-search-empty">
            <Search size={25} />
            <strong>A little expression goes a long way</strong>
            <p>
              Press Search to contact {providerName} directly from your browser and load still
              previews. Search terms and preview requests go to {providerName}.
            </p>
          </div>
        ) : null}
        {busy && (
          <div className="gif-search-loading" role="status">
            Finding GIFs…
            <div className="gif-search-skeletons">
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}{' '}
            <button
              type="button"
              onClick={() =>
                configError
                  ? setConfigVersion((value) => value + 1)
                  : setRevision((value) => value + 1)
              }
            >
              Retry
            </button>
          </p>
        )}
        {page && (
          <>
            <div className="gif-search-results" aria-label="GIF search results">
              {page.items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  title={item.title || 'Send GIF'}
                  aria-label={'Send GIF: ' + (item.title || item.id)}
                  disabled={sending !== null}
                  onClick={() => void send(item)}
                >
                  {failedPreviews.has(item.id) ? (
                    <span className="gif-preview-unavailable">
                      <ImageOff size={20} /> Preview unavailable
                    </span>
                  ) : (
                    <img
                      src={item.previewUrl}
                      alt={item.title || 'GIF preview'}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      crossOrigin="anonymous"
                      width={item.width}
                      height={item.height}
                      onError={() =>
                        setFailedPreviews((previous) => new Set([...previous, item.id]))
                      }
                    />
                  )}
                  {sending === item.id && <span>Sending…</span>}
                </button>
              ))}
            </div>
            {!page.items.length && (
              <p className="gif-search-no-results">No GIFs found. Try a different phrase.</p>
            )}
            {page.omittedCount > 0 && <small>Some unsupported results were omitted.</small>}
            {page.nextCursor && (
              <button type="button" className="gif-more" onClick={() => setCursor(page.nextCursor)}>
                More GIFs <ArrowUpRight size={13} />
              </button>
            )}
          </>
        )}
        <footer className="gif-search-attribution">
          {provider === 'klipy' ? (
            <a href="https://klipy.com" target="_blank" rel="noopener noreferrer">
              Powered by KLIPY
            </a>
          ) : (
            <a href="https://giphy.com" target="_blank" rel="noopener noreferrer">
              <img src={giphyAttribution} alt="Powered By GIPHY" width={100} />
            </a>
          )}
        </footer>
      </div>
    </section>
  );
}
