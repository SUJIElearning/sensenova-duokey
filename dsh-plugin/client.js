/**
 * @author zhaoyu · https://github.com/SUJIElearning/sensenova-duokey
 * Client half: one compact "available/total" readout below the composer card.
 *
 * Polls the Host relay (loopback, so no CORS problem inside the page) and
 * renders a coloured dot plus the counters. Inherits host theme tokens only;
 * no custom colours, no layout takeover, no DOM outside this component.
 */
window.__ModuleLoader__.load({
  id: '@sujielearning/dsh-sensenova-key-status',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Host relay endpoint (see the Host half of this bundle). */
    const ENDPOINT = 'http://127.0.0.1:15799/keys';
    /** Refresh cadence; the proxy counters change on request traffic only. */
    const POLL_MS = 5000;

    /**
     * Composer dock readout: `● 5/6 Key`.
     * Renders nothing while the proxy is unreachable, so a stopped proxy never
     * leaves a stale or alarming badge behind.
     */
    function KeyStatus() {
      const [status, setStatus] = React.useState(null);

      React.useEffect(() => {
        let cancelled = false;
        let timer = null;

        const poll = () => {
          fetch(ENDPOINT, { cache: 'no-store' })
            .then((response) => response.json())
            .then((data) => {
              if (!cancelled) setStatus(data);
            })
            .catch(() => {
              if (!cancelled) setStatus({ ok: false });
            });
        };

        poll();
        timer = setInterval(poll, POLL_MS);
        return () => {
          cancelled = true;
          if (timer !== null) clearInterval(timer);
        };
      }, []);

      if (status === null || status.ok !== true) return null;

      const available = Number(status.available) || 0;
      const total = Number(status.total) || 0;
      const tone = available === 0
        ? 'var(--dsw-alias-state-error-primary)'
        : available === total
          ? 'var(--dsw-alias-state-success-primary)'
          : 'var(--dsw-alias-state-warn-primary)';

      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          padding: '2px 0',
          fontSize: '12px',
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-secondary)',
          fontVariantNumeric: 'tabular-nums',
          userSelect: 'none',
        },
        title: `${available}/${total} SenseNova key(s) available`,
      },
        h('span', {
          'aria-hidden': true,
          style: {
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: tone,
            flex: 'none',
          },
        }),
        h('span', null, `${available}/${total}`),
        h('span', { style: { opacity: 0.7 } }, 'Key'));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'sensenova-key-status',
          order: 50,
        }, KeyStatus));
      },
    };
  },
});