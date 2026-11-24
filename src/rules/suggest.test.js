import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { profile, shapeOf, suggest } from './suggest.js';

const fields = ['firstName', 'postcode', 'sessionType'];
const records = [
  ...Array.from({ length: 6 }, () => ({ firstName: 'Evie', postcode: 'sw1a1aa', sessionType: 'lead' })),
  { firstName: 'ZOË', postcode: '', sessionType: 'course' },
];

/** A fetch that answers like the Messages API, or fails as told. */
function fakeFetch({ status = 200, stopReason = 'end_turn', text, throws } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (throws) throw throws;
    return new Response(
      JSON.stringify(status === 200 ? { stop_reason: stopReason, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] } : { type: 'error', error: { type: 'overloaded_error' } }),
      { status },
    );
  };
  return { fetchImpl, calls };
}

const answer = (rules) => JSON.stringify({ rules });
const run = (fetchImpl) => suggest({ fieldProfile: profile(records, fields), fields, apiKey: 'k', model: 'm', fetchImpl });

describe('profile', () => {
  it('describes shapes without the values, and leaves out rare shapes', () => {
    assert.equal(shapeOf("O'NEILL"), "A'A");
    assert.equal(shapeOf('sw1a 1aa'), 'a9a 9a');
    assert.equal(shapeOf('李伟'), 'x');
    assert.equal(shapeOf('Nguye\u0302\u0303n'), 'Aa', 'no accents left between letters');
    const result = profile(records, fields, { knownValues: { sessionType: ['lead', 'course'] } });
    assert.deepEqual(result.firstName, { records: 7, empty: 0, common: [{ shape: 'Aa', count: 6 }] });
    assert.deepEqual(result.postcode.empty, 1);
    assert.deepEqual(result.sessionType.common, [{ value: 'lead', count: 6 }]);
    assert.ok(!JSON.stringify(result).includes('Evie'));
    // A repeated value outside the known list is still only a shape.
    const odd = Array.from({ length: 5 }, () => ({ sessionType: 'Evie Okafor' }));
    assert.deepEqual(profile(odd, ['sessionType'], { knownValues: { sessionType: ['lead'] } }).sessionType.common, [{ shape: 'Aa Aa', count: 5 }]);
  });
});

describe('suggest', () => {
  it("checks the AI's answer, and fails clearly when the AI is unavailable, slow, refuses or answers badly", async () => {
    const { fetchImpl: unsafe } = fakeFetch({
      text: answer([
        { field: 'password', op: 'lowercase', format: null, reason: 'unknown field' },
        { field: 'postcode', op: 'run_shell', format: null, reason: 'unknown operation' },
      ]),
    });
    const checked = await run(unsafe);
    assert.deepEqual(checked.rules, [], 'only known fields and operations survive');
    assert.equal(checked.errors.length, 2);

    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const cases = [
      [fakeFetch({ status: 529 }), /responded 529 \(overloaded_error\)/],
      [fakeFetch({ throws: timeout }), /did not answer within 60 s/],
      [fakeFetch({ throws: new TypeError('fetch failed') }), /Could not reach Claude/],
      [fakeFetch({ stopReason: 'refusal', text: '' }), /declined/],
      [fakeFetch({ stopReason: 'max_tokens', text: '{"rules": [' }), /incomplete/],
      [fakeFetch({ text: 'Sure! Here are some rules' }), /not answer with JSON/],
    ];
    for (const [{ fetchImpl }, message] of cases) await assert.rejects(run(fetchImpl), message);
    await assert.rejects(suggest({ fieldProfile: {}, fields, apiKey: '', model: 'm' }), /ANTHROPIC_API_KEY/);
  });
});
