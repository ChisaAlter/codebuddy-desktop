import { describe, expect, it } from 'vitest';
import { envFlagEnabled, REPL_ENV_KEY, setEnvFlag } from '../../src/lib/env-flags.js';

describe('env-flags (G13 REPL toggle)', () => {
  it('detects truthy flag spellings', () => {
    expect(envFlagEnabled({ [REPL_ENV_KEY]: '1' }, REPL_ENV_KEY)).toBe(true);
    expect(envFlagEnabled({ [REPL_ENV_KEY]: 'true' }, REPL_ENV_KEY)).toBe(true);
    expect(envFlagEnabled({ [REPL_ENV_KEY]: 'ON' }, REPL_ENV_KEY)).toBe(true);
    expect(envFlagEnabled({ [REPL_ENV_KEY]: true }, REPL_ENV_KEY)).toBe(true);
    expect(envFlagEnabled({ [REPL_ENV_KEY]: '0' }, REPL_ENV_KEY)).toBe(false);
    expect(envFlagEnabled({ [REPL_ENV_KEY]: 'false' }, REPL_ENV_KEY)).toBe(false);
    expect(envFlagEnabled({}, REPL_ENV_KEY)).toBe(false);
    expect(envFlagEnabled(null, REPL_ENV_KEY)).toBe(false);
    expect(envFlagEnabled(['1'], REPL_ENV_KEY)).toBe(false);
  });

  it('setEnvFlag writes "1" and removes on disable, preserving other keys', () => {
    const enabled = setEnvFlag({ FOO: 'bar' }, REPL_ENV_KEY, true);
    expect(enabled).toEqual({ FOO: 'bar', [REPL_ENV_KEY]: '1' });

    const disabled = setEnvFlag(enabled, REPL_ENV_KEY, false);
    expect(disabled).toEqual({ FOO: 'bar' });
    expect(Object.prototype.hasOwnProperty.call(disabled, REPL_ENV_KEY)).toBe(false);

    // does not mutate input; tolerates null env
    expect(enabled).toEqual({ FOO: 'bar', [REPL_ENV_KEY]: '1' });
    expect(setEnvFlag(null, REPL_ENV_KEY, true)).toEqual({ [REPL_ENV_KEY]: '1' });
    expect(setEnvFlag(undefined, REPL_ENV_KEY, false)).toEqual({});
  });
});
