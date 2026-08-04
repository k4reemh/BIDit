import type { AddressCheck } from '../api';

/**
 * What the carrier thinks of an address the user just saved.
 *
 * Advisory, never a gate. Carrier databases are wrong about plenty of real
 * addresses, so this warns and offers a correction rather than refusing the
 * save. The alternative is a bad address failing weeks later at label time,
 * which costs a lot more to unpick than a sentence here.
 */
export default function AddressCheckNote({
  check,
  onApply,
}: {
  check: AddressCheck | null;
  onApply?: (suggestion: NonNullable<AddressCheck['suggestion']>) => void;
}) {
  // Nothing to say when the carrier is happy and had no corrections, or when we
  // could not reach it at all. Silence beats "we could not check this".
  if (!check || check.status === 'unchecked') return null;
  if (check.status === 'ok' && !check.suggestion) return null;

  const s = check.suggestion;
  const line = s && [s.line1, s.city, s.region, s.postal].filter(Boolean).join(', ');

  return (
    <div className={`addrchk addrchk--${check.status === 'ok' ? 'tweak' : 'warn'}`}>
      {check.status === 'warning' ? (
        <>
          <b>The carrier could not confirm this address.</b>
          <p>
            You can still save it, but a label may fail.
            {check.messages.length > 0 ? ` ${check.messages[0]}` : ''}
          </p>
        </>
      ) : (
        <>
          <b>The carrier writes this address slightly differently.</b>
          <p>{line}</p>
          {onApply && s && (
            <button type="button" className="addrchk__apply" onClick={() => onApply(s)}>
              Use the carrier’s version
            </button>
          )}
        </>
      )}
    </div>
  );
}
