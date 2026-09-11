/** Verify namespaces used for source-based test grouping. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namespacesByLine } from '../src/namespaces';
import { validateTestGroupByMode } from '../src/test-grouping';

test('nested namespaces survive fixture classes, comments, strings and aliases', () => {
  const lines = namespacesByLine(`namespace delta_control {
namespace testing {
class ChiCalculationTest : public ::testing::Test {
  const char* text = "} namespace fake {";
};
/* namespace bogus { */
TEST_F(ChiCalculationTest, Calculates) {}
}
}
namespace alias = delta_control;
TEST(Global, Works) {}
namespace outer::inner {
TEST(Nested, Works) {}
}
`);
  assert.deepEqual(lines[6], ['delta_control', 'testing']);
  assert.deepEqual(lines[10], []);
  assert.deepEqual(lines[12], ['outer', 'inner']);
});

test('raw strings and multiline macros do not add scopes', () => {
  const lines = namespacesByLine(
    '#define SCOPE namespace fake {\\\n{\nconst char* s = R"tag(namespace fake {\n})tag";\nTEST(Global, Works) {}',
  );
  assert.deepEqual(lines[4], []);
});

test('only supported grouping modes are accepted', () => {
  for (const mode of ['namespace', 'executable', 'name']) validateTestGroupByMode(mode);
  for (const mode of ['', null, {}, 'suite']) assert.throws(() => validateTestGroupByMode(mode));
});
