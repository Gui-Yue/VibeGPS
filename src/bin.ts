#!/usr/bin/env node
import { buildCli } from "./cli";

void buildCli().parseAsync(process.argv);
