cmake_minimum_required(VERSION 3.14)
project(another_hidden_package)
message(FATAL_ERROR "An ignored ancestor should prevent all descendant packages from being configured")
