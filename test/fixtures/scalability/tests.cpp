/** Exercise discovery and verbose execution with many cases in one binary. */
#include <gtest/gtest.h>
#include <iostream>

/** Give each case a distinct parameter and output marker. */
class Scalability : public testing::TestWithParam<int> {};

TEST_P(Scalability, ReportsOutput) {
  for (int line = 0; line < 100; ++line) {
    std::cout << "case " << GetParam() << " output " << line << '\n';
  }
  EXPECT_GE(GetParam(), 0);
}

INSTANTIATE_TEST_SUITE_P(Cases, Scalability, testing::Range(0, 1000));
