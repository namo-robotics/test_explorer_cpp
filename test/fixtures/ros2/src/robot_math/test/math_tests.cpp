#include <gtest/gtest.h>
#include <cstdlib>
#include <fstream>
#include <iostream>
TEST(Math, Adds) { EXPECT_EQ(2 + 3, 5); std::cout << "robot_math output\n"; }
TEST(Math, EnvironmentAndWorkingDirectory) {
  ASSERT_NE(std::getenv("EXPLORER_PACKAGE"), nullptr);
  EXPECT_STREQ(std::getenv("EXPLORER_PACKAGE"), "robot_math");
  EXPECT_TRUE(std::ifstream("package.xml").good());
}
