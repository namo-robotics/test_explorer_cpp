#include <gtest/gtest.h>
TEST(Geometry, Area) { EXPECT_EQ(4 * 5, 20); }
class Dimensions : public testing::TestWithParam<int> {};
TEST_P(Dimensions, Positive) { EXPECT_GT(GetParam(), 0); }
INSTANTIATE_TEST_SUITE_P(Rectangle, Dimensions, testing::Values(2, 3));
