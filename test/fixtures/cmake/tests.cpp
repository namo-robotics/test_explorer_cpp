#include <gtest/gtest.h>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>
#include <sys/resource.h>

TEST(Basic, Pass) { std::cout << "case stdout\n"; std::cerr << "case stderr\n"; EXPECT_EQ(2 + 2, 4); }
TEST(Basic, Fail) { EXPECT_EQ(1, 2); }
TEST(Basic, Skip) { GTEST_SKIP() << "intentional skip"; }
TEST(Basic, DISABLED_Optional) { SUCCEED(); }
TEST(Process, Slow) { std::this_thread::sleep_for(std::chrono::milliseconds(350)); }
TEST(Process, Crash) { rlimit limit{0, 0}; setrlimit(RLIMIT_CORE, &limit); std::abort(); }
class Values : public testing::TestWithParam<int> {};
TEST_P(Values, Positive) { EXPECT_GT(GetParam(), 0); }
INSTANTIATE_TEST_SUITE_P(Numbers, Values, testing::Values(1, 2));
template <typename T> class Typed : public testing::Test {};
using Types = testing::Types<int, long>;
TYPED_TEST_SUITE(Typed, Types);
TYPED_TEST(Typed, Works) { EXPECT_EQ(TypeParam(1), 1); }
