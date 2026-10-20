# Continuing in VS Code with Claude Code

## One-time setup on your computer

1. Install: [VS Code](https://code.visualstudio.com/), the **Claude Code** extension
   (Extensions panel, search "Claude Code"), Node.js 22 or newer, Docker
   Desktop, PostgreSQL 16 (or just use Docker), the AWS CLI v2 and Terraform.
2. Unzip `reservo.zip`, then in VS Code use **File › Open Folder** on the
   `reservo` folder. Claude Code reads `CLAUDE.md` automatically.
3. Put it on GitHub (private repo) so CI runs and you have a backup:
   ```bash
   gh repo create reservo --private --source=. --push
   ```
4. AWS account:
   - Turn on MFA for the root user, then stop using root.
   - In **IAM Identity Center**, create a user for yourself with the
     `AdministratorAccess` permission set.
   - In **Billing › Budgets**, create a monthly budget of €60 with an email alert.
5. Sign in from the VS Code terminal (short-lived credentials, no access keys):
   ```bash
   aws configure sso      # once: profile name "reservo", region eu-south-2
   aws sso login --profile reservo
   export AWS_PROFILE=reservo
   aws sts get-caller-identity
   ```

## First prompts to give Claude Code

Run the app locally first:

> Set up the project locally with Docker for Postgres, run the tests, and start the demo studio.

Then deploy:

> Follow the "Next task: deploy to AWS" section in CLAUDE.md. Write the Terraform in deploy/aws, show me the plan and the monthly cost estimate before applying anything.

Claude Code asks before running commands. Approve read-only commands freely;
read every `terraform apply` plan before saying yes. `.claude/settings.json`
already blocks `terraform destroy` and database deletion.

## Do I need a skill?

No. `CLAUDE.md` holds the project context and rules, which is what a skill
would add. Consider a skill later only for something you repeat often, such as
"onboard a new studio" (the steps in `docs/ONBOARDING.md`).
