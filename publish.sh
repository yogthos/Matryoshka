#!/bin/bash

npm login && pnpm version patch && pnpm run build && pnpm run test:run && pnpm publish
