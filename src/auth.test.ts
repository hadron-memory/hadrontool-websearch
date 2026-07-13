import { describe, expect, it } from 'vitest';
import { authSchema, buildAuthHeader } from './auth.js';

describe('buildAuthHeader', () => {
  it('builds a bearer Authorization header', () => {
    expect(buildAuthHeader({ type: 'bearer', token: 'abc' })).toEqual({ authorization: 'Bearer abc' });
  });

  it('builds a basic Authorization header (base64)', () => {
    expect(buildAuthHeader({ type: 'basic', username: 'u', password: 'p' })).toEqual({
      authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
    });
  });

  it('builds a named header, lowercased', () => {
    expect(buildAuthHeader({ type: 'header', name: 'X-Subscription-Token', value: 'k' })).toEqual({
      'x-subscription-token': 'k',
    });
  });
});

describe('authSchema', () => {
  it('accepts a valid named-header credential', () => {
    expect(authSchema.safeParse({ type: 'header', name: 'X-Api-Key', value: 'k' }).success).toBe(true);
  });

  it('rejects a control character in a token (header-injection shape)', () => {
    expect(authSchema.safeParse({ type: 'bearer', token: 'a\r\nb' }).success).toBe(false);
  });

  it('rejects using the header channel to set authorization directly', () => {
    expect(authSchema.safeParse({ type: 'header', name: 'authorization', value: 'Bearer x' }).success).toBe(false);
  });

  it('rejects an unknown auth type', () => {
    expect(authSchema.safeParse({ type: 'query', key: 'k' }).success).toBe(false);
  });
});
