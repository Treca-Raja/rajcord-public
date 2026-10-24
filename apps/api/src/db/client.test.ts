import { it, expect, vi } from 'vitest';
import { createDatabase } from './client.js';
it('handles expected idle PostgreSQL restart errors without credential logs or crashing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}),
    database = createDatabase('postgresql://test:private@127.0.0.1:1/test');
  try {
    database.pool.emit(
      'error',
      Object.assign(new Error('private connection details'), { code: '57P01' }),
    );
    expect(warn).not.toHaveBeenCalled();
    database.pool.emit(
      'error',
      Object.assign(new Error('private connection details'), { code: 'UNKNOWN' }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('private');
  } finally {
    warn.mockRestore();
    await database.pool.end();
  }
});
