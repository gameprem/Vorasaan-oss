#!/usr/bin/env node

const { Command } = require('commander');
const p = require('@clack/prompts');

const program = new Command();

program
  .name('vorasaan')
  .description('The Open-Source Agentic Alignment Engine CLI')
  .version('1.0.0');

program
  .command('grill')
  .description('Start an interactive grilling session for a Jira ticket')
  .requiredOption('-j, --jira <ticket>', 'Jira Ticket ID (e.g. PROJ-88)')
  .action(async (options) => {
    p.intro(`🤖 Vorasaan Grilling Session: ${options.jira}`);
    // Logic คุยกับ Agent จะอยู่ที่นี่
    p.outro('Context has been verified and saved to .vorasaan/specs!');
  });

program.parse(process.argv);