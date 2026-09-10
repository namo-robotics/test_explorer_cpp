FROM node:22-bookworm-slim AS node
FROM ros:lyrical-ros-base

COPY --from=node /usr/local/ /usr/local/
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake gdb git gh openssh-client sudo ripgrep \
    libgtest-dev ros-lyrical-ament-cmake-gtest python3-colcon-common-extensions \
    xvfb xauth libgtk-3-0 libnss3 libasound2t64 libgbm1 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex @anthropic-ai/claude-code

RUN id ubuntu >/dev/null 2>&1 || useradd --uid 1000 --create-home --shell /bin/bash ubuntu
RUN echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ubuntu \
    && chmod 0440 /etc/sudoers.d/ubuntu \
    && mkdir -p /home/ubuntu/.config/gh /home/ubuntu/.ssh /home/ubuntu/.claude /home/ubuntu/.codex \
    && touch /home/ubuntu/.claude.json \
    && echo 'source /opt/ros/lyrical/setup.bash' >> /home/ubuntu/.bashrc \
    && chown -R ubuntu:ubuntu /home/ubuntu

USER ubuntu
WORKDIR /home/ubuntu
