#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { addCommand } from "./commands/add.js";
import { compileCommand } from "./commands/compile.js";
import { lintCommand } from "./commands/lint.js";
import { healCommand } from "./commands/heal.js";
import { queryCommand } from "./commands/query.js";
import { searchCommand } from "./commands/search.js";
import { graphCommand } from "./commands/graph.js";
import { statusCommand } from "./commands/status.js";
import { removeCommand } from "./commands/remove.js";
import { contradictionsCommand } from "./commands/contradictions.js";
import { modelsCommand } from "./commands/models.js";

const program = new Command();

program
  .name("wikic")
  .description("LLM-callable wiki compiler CLI")
  .version("0.1.0");

program.addCommand(initCommand);
program.addCommand(addCommand);
program.addCommand(compileCommand);
program.addCommand(lintCommand);
program.addCommand(healCommand);
program.addCommand(queryCommand);
program.addCommand(searchCommand);
program.addCommand(graphCommand);
program.addCommand(statusCommand);
program.addCommand(removeCommand);
program.addCommand(contradictionsCommand);
program.addCommand(modelsCommand);

program.parse();
