/** [B] Terms and Privacy templates. Not legal advice: counsel must review before launch. */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { TOKEN } from '@/lib/token';

const ENTITY = '[Company legal name]';
const CONTACT = '[legal@your-domain]';
const UPDATED = '[effective date]';

function Sec({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section id={`s${n}`}>
      <h2>
        {n}. {title}
      </h2>
      {children}
    </section>
  );
}

function Banner() {
  return (
    <div className="legal-tpl" role="note">
      <b>Template: have counsel review before launch.</b> Placeholders in [brackets] must be filled in, and the text checked against the laws that apply where Sway is offered.
    </div>
  );
}

export function Terms() {
  return (
    <article className="legal">
      <Banner />
      <p className="t3">Last updated {UPDATED}</p>
      <Sec n={1} title="About these terms">
        <p>
          These terms are an agreement between you and {ENTITY} (“Sway”, “we”). They cover the Sway website and app, the Sway API and the Sway smart contracts on Robinhood Chain
          (together, “Sway”). By connecting X or using Sway you accept them. If you don’t agree, don’t use Sway.
        </p>
      </Sec>
      <Sec n={2} title="Who can use Sway">
        <p>
          You must be at least 18 (or the age of majority where you live), able to enter a binding contract, and not barred from using crypto-asset services under the laws that
          apply to you, including sanctions laws. [Restricted jurisdictions.] One account per X account.
        </p>
      </Sec>
      <Sec n={3} title="Your account">
        <p>
          You sign in with X using read-only access: Sway can’t post for you or see your password. You are responsible for what happens under your account and for keeping your
          devices and wallets secure. Tell us at {CONTACT} if you think your account was misused.
        </p>
      </Sec>
      <Sec n={4} title="Creator keys are access, not investments">
        <ul>
          <li>A creator key gives you access to that creator’s room and holder-only posts while you hold at least one key. That is all it does.</li>
          <li>
            Keys are not shares, securities, deposits or investment products. They give no ownership, voting or profit rights in a creator, in Sway or in anything else, and no one
            promises that they will keep or gain value.
          </li>
          <li>
            Prices come from a public bonding curve: they rise when people buy and fall when people sell. Keys can lose value, including all of it, and there may be no one else
            buying when you want to sell.
          </li>
          <li>
            Every trade pays the fees shown before you sign (creator, protocol, holders and referral). Transactions on Robinhood Chain are final: we can’t reverse, refund or cancel
            them.
          </li>
          <li>A creator’s first key is minted to them and can never be sold. Buying may be limited for the first minutes of a market.</li>
        </ul>
      </Sec>
      <Sec n={5} title="Sway score and reach value">
        <p>
          The Sway score and “reach value” are in-app estimates calculated with our published, open-source model from public X metrics. They are not a valuation, an appraisal, a
          price target or financial advice, and they can change at any time.
        </p>
      </Sec>
      <Sec n={6} title="Points, tiers and the Genesis pass">
        <p>
          Points and tiers measure activity on Sway. They have no monetary value until we announce otherwise, can’t be bought, sold or transferred, and may be adjusted or removed for
          abuse (for example accounts flagged as bots or farms). Any future airdrop, Genesis pass or reward is not guaranteed and will follow the terms published with it. Genesis
          passes are soulbound and can’t be transferred.
        </p>
      </Sec>
      <Sec n={7} title="Staking">
        <p>
          Staking {TOKEN.the} lowers your trading fees and shares part of the protocol fee with stakers. Staker rewards depend on trading volume: they are variable and may be zero.
          Unstaking has a cooldown period during which your tokens can’t be withdrawn.
        </p>
      </Sec>
      <Sec n={8} title="Fan markets">
        <p>
          Sway may open a fan market for an X account that hasn’t joined. That account does not run, endorse or profit from the market until its owner signs in with X and claims it.
          The creator fee is held in escrow for the owner. Owners can claim their market, or ask for a review or a takedown from the market’s page. We may halt buying on any market;
          selling always stays open so holders can exit.
        </p>
      </Sec>
      <Sec n={9} title="Wallets and self-custody">
        <p>
          Sway wallets are self-custodial. A Sway wallet’s key is created and kept in your browser; if you use your own wallet, its keys stay with you. We never hold your keys, so we
          can’t recover a lost key, restore funds sent to the wrong address or undo a transaction. Back up your wallet key and keep it private. You pay the network fees of your
          transactions.
        </p>
      </Sec>
      <Sec n={10} title="Your content and conduct">
        <p>
          You own what you post. You give Sway a worldwide, non-exclusive, royalty-free licence to host, display and distribute it as part of running Sway. Don’t post or do anything
          illegal, harassing, hateful, deceptive or infringing; don’t impersonate others, spam, manipulate markets, farm points or interfere with Sway or its contracts.
        </p>
        <p>
          We may hide or remove content, limit features, flag accounts or suspend access when we believe these terms were broken. You can report posts and accounts and block other
          members at any time.
        </p>
      </Sec>
      <Sec n={11} title="Boosts, tips and subscriptions">
        <p>
          Boosts, tips and subscriptions are paid in ETH at the price shown when you pay. Boost payments go to the Sway treasury; tips and subscriptions go to the creator. They are
          final and don’t change who can see a post.
        </p>
      </Sec>
      <Sec n={12} title="Risks">
        <p>
          Using Sway involves risks you accept: smart-contract bugs (the contracts have not been audited until we publish an audit report), network outages, price volatility,
          changes in law and regulation, and loss of access to your wallet.
        </p>
      </Sec>
      <Sec n={13} title="Disclaimers and liability">
        <p>
          Sway is provided “as is” and “as available”. To the extent the law allows, we disclaim all warranties and are not liable for indirect or consequential losses, lost profits
          or lost data. [Liability cap and consumer-law carve-outs.]
        </p>
      </Sec>
      <Sec n={14} title="Ending your account">
        <p>
          You can download your data or delete your account at any time in <Link href="/settings">Settings</Link>. See the <Link href="/privacy">Privacy Policy</Link> for what is
          removed and what stays onchain.
        </p>
      </Sec>
      <Sec n={15} title="Changes, law and contact">
        <p>
          We may update these terms; we’ll show the date above and tell you in the app about material changes. [Governing law and venue.] Questions: {CONTACT}.
        </p>
      </Sec>
    </article>
  );
}

export function Privacy() {
  return (
    <article className="legal">
      <Banner />
      <p className="t3">Last updated {UPDATED}</p>
      <Sec n={1} title="Who we are">
        <p>
          {ENTITY} runs Sway and is responsible for your personal data. Contact: {CONTACT}. [Representative / data protection officer, if required.]
        </p>
      </Sec>
      <Sec n={2} title="What we take from X">
        <p>When you connect X we read, with read-only access:</p>
        <ul>
          <li>your X user id, handle, display name and avatar URL (and your public bio for your profile);</li>
          <li>
            the public metrics our open scoring model uses: follower count, verified status, account age, and likes, reposts and replies on your recent public posts (the
            numbers, not the posts).
          </li>
        </ul>
        <p>
          Your X access token is used only during your session. It lives in our session store, is never written to our database and is deleted when you log out or the session
          expires.
        </p>
      </Sec>
      <Sec n={3} title="What you create on Sway">
        <p>
          Posts and replies, images you upload, likes, reposts, follows, subscriptions, direct messages, room messages, reports and blocks, notifications, task verifications,
          referrals and your points ledger.
        </p>
      </Sec>
      <Sec n={4} title="Wallets and onchain data">
        <p>
          We store the wallet addresses you create or link. Transactions on Robinhood Chain (key trades, claims, stakes, payments) are public and permanent. We mirror them to show
          prices, holdings and activity. We never receive your wallet keys.
        </p>
      </Sec>
      <Sec n={5} title="How we use your data">
        <p>
          To run Sway (profiles, feeds, rooms, holder-only access, messages, notifications), to compute your score, points and tier, to keep Sway safe (moderation, abuse and bot
          detection, security) and to meet legal obligations. [Legal bases for each purpose.]
        </p>
      </Sec>
      <Sec n={6} title="What is public">
        <p>
          Your profile, Sway score, reach value, key market, public posts and replies, and everything onchain. Holder-only and subscriber posts are shown only to holders and
          subscribers. Direct messages are visible to you and the other person.
        </p>
      </Sec>
      <Sec n={7} title="Who we share it with">
        <p>
          Service providers that host and operate Sway for us [list], under contract; authorities when the law requires it. We don’t sell your personal data and we don’t use it
          for advertising.
        </p>
      </Sec>
      <Sec n={8} title="Cookies and local storage">
        <p>
          One session cookie keeps you signed in, and a referral cookie remembers who invited you. Your browser’s local storage keeps your Sway wallet key (if you use one) and
          small preferences. No advertising trackers.
        </p>
      </Sec>
      <Sec n={9} title="Download and delete your data">
        <p>
          In <Link href="/settings">Settings</Link> you can download everything we hold about you as one JSON file (profile, posts, messages you sent, notifications, points
          ledger, wallets and trades), and delete your account.
        </p>
        <p>
          Deleting your account removes your profile details, the text and images of your posts, your direct messages, likes, reposts, follows, subscriptions, blocks, the
          reports you filed, your notifications and uploads, and signs you out everywhere. What stays: onchain records we can’t erase (your key market, trades, holdings, claims
          and stakes, shown under “Deleted account”), the wallet links that tie your market to its wallet, and your points ledger as an accounting record. Signing in with the same
          X account later starts a fresh profile.
        </p>
      </Sec>
      <Sec n={10} title="Retention and security">
        <p>
          We keep your data while your account exists and delete it as described above when you delete your account, except where the law requires us to keep it longer. [Backup
          retention period.] We protect it with access controls, encryption in transit and least-privilege access.
        </p>
      </Sec>
      <Sec n={11} title="Your rights">
        <p>
          Depending on where you live you may have the right to access, correct, delete, restrict or port your data and to object to processing, and to complain to your data
          protection authority. Write to {CONTACT}. [International transfers.]
        </p>
      </Sec>
      <Sec n={12} title="Children and changes">
        <p>Sway is not for anyone under 18. We’ll show the date above when this policy changes and tell you in the app about material changes.</p>
      </Sec>
    </article>
  );
}
