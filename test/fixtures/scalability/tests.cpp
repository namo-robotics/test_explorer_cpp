/** Exercise discovery and execution with reproducible, uneven case workloads. */
#include <gtest/gtest.h>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <random>
#include <thread>

/** Give each case a distinct parameter, workload, and output marker. */
class Scalability : public testing::TestWithParam<int> {};

TEST_P(Scalability, ReportsOutput) {
  const char* configured_seed = std::getenv("CPP_EXPLORER_LOAD_SEED");
  const auto seed = configured_seed ? std::stoul(configured_seed) : 20260910u;
  std::mt19937 random(static_cast<std::uint32_t>(seed) + GetParam());
  const auto wait_ms = random() % 100 < 3 ? 40 + random() % 160 : random() % 3;
  const auto iterations = 1000 + random() % 49000;
  const auto lines = 10 + random() % 191;
  std::this_thread::sleep_for(std::chrono::milliseconds(wait_ms));
  std::uint32_t checksum = random();
  for (unsigned iteration = 0; iteration < iterations; ++iteration) {
    checksum ^= checksum << 13;
    checksum ^= checksum >> 17;
    checksum ^= checksum << 5;
  }
  std::cout << "workload seed=" << seed << " wait_ms=" << wait_ms
            << " iterations=" << iterations << " lines=" << lines
            << " checksum=" << checksum << '\n';
  for (unsigned line = 0; line < lines; ++line) {
    std::cout << "case " << GetParam() << " output " << line << '\n';
  }
  EXPECT_GE(GetParam(), 0);
}

INSTANTIATE_TEST_SUITE_P(Cases, Scalability, testing::Range(0, 1000));
