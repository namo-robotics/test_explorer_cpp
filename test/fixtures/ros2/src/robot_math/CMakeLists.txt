cmake_minimum_required(VERSION 3.14)
project(robot_math)
find_package(ament_cmake REQUIRED)
if(BUILD_TESTING)
  find_package(ament_cmake_gtest REQUIRED)
  ament_add_gtest(math_tests test/math_tests.cpp
    ENV "EXPLORER_PACKAGE=robot_math" TIMEOUT 20
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
endif()
ament_package()
