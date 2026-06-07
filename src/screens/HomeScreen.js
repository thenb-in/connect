import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  Platform,
  ToastAndroid,
  TouchableOpacity,
  Modal,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import theme from '../theme';
import AppHeader from '../components/AppHeader';
import { initiateTrackedCall } from '../utils/makeImmediateCall';
import ReconnectCard from '../components/ReconnectCard';
import { SpotlightCard } from '../components/SpotlightHero';
import SlotMachine from '../components/SlotMachine';
import SectionHeader from '../components/SectionHeader';
import EmptyState from '../components/EmptyState';
import MilestonesCard from '../components/MilestonesCard';
import ConnectSetupGate from '../components/ConnectSetupGate';
import { useConnectAnalysis } from '../hooks/useConnectAnalysis';
import { useMilestones } from '../hooks/useMilestones';
import {
  WANT_TO_CONNECT_GROUP_ID,
  UNKNOWN_GROUP_ID,
  getShowHiddenCards,
} from '../storage';
import { shareApp } from '../utils/appShare';
import AboutModal from '../components/AboutModal';

// Fisher-Yates shuffle (returns a new array; never mutates the input).
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * The Connect Mode home dashboard. Built to feel like a "morning reflection"
 * surface, not a CRM dashboard: a small set of warmly-labelled lanes, soft
 * empty states, no charts or KPIs.
 *
 * The lanes correspond directly to the buckets the engine produces:
 *   - Reconnect Today
 *   - Lost Connections
 *   - Recently Reconnected
 *   - Missed Calls to Return
 */
const HomeScreen = ({ navigation }) => {
  const { analysis, refreshing, refresh, syncOnFocus } = useConnectAnalysis();
  // Recompute milestone progress whenever the analysis regenerates: reconnects
  // are derived from the call-log store, which a refresh/focus sync updates.
  const { milestones } = useMilestones(analysis?.generatedAt);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  // iOS-only "show hidden cards" setting (toggled in Settings). Re-read on focus
  // so toggling it there reflects when the user returns to Home.
  const [showHidden, setShowHidden] = useState(() => getShowHiddenCards());

  // Carousel page sizing: each spotlight card is ~86% of the screen so the next
  // card peeks ~10% on the right edge, hinting that it's swipeable.
  const { width: screenWidth } = useWindowDimensions();
  const CARD_W = Math.round(screenWidth * 0.86);
  const CARD_GAP = theme.spacing.md;

  // Whenever the home tab regains focus, pull the call-log delta since the
  // last sync (no contacts re-import, no spinner). This is what gives the
  // "real-time feel" — when the user returns from the system dialer or
  // another tab, fresh outgoing calls land in the engine within a beat.
  useFocusEffect(
    useCallback(() => {
      syncOnFocus();
      setShowHidden(getShowHiddenCards());
    }, [syncOnFocus]),
  );

  const handleRefresh = useCallback(async () => {
    const result = await refresh();
    if (Platform.OS !== 'android') { return; }
    if (!result) {
      ToastAndroid.show('Couldn\'t sync', ToastAndroid.LONG);
      return;
    }
    if (result.refreshError) {
      ToastAndroid.show(result.refreshError, ToastAndroid.LONG);
      return;
    }
    ToastAndroid.show('Synced', ToastAndroid.SHORT);
  }, [refresh]);

  const randomPerGroup = useMemo(() => {
    if (!analysis?.profiles?.length) return [];
    const byGroup = new Map();
    analysis.profiles.forEach((p) => {
      // "Say hi to someone today" is a reminder lane in spirit, so the same
      // suppression rules apply: skip don't-suggest contacts and groups marked
      // doNotRemind / helpers.
      if (p.remindersSuppressed) return;
      (p.groups || []).forEach((g) => {
        // Skip helpers and do-not-remind groups, and the synthetic "Unknown"
        // catch-all (the group literally named Unknown that holds everyone in
        // no real group). But KEEP real groups that merely sit in the Unknown
        // *category* — e.g. the name-token clusters from onboarding ("Rao",
        // "IITB") default to categoryId 'unknown' yet are genuine circles worth
        // saying hi from.
        if (
          g?.doNotRemind ||
          g?.categoryId === 'helpers' ||
          g?.id === UNKNOWN_GROUP_ID
        ) {
          return;
        }
        const arr = byGroup.get(g.id) || [];
        arr.push(p);
        byGroup.set(g.id, arr);
      });
    });
    // Shuffle across BOTH groups and names: walk groups in random order, and
    // within each pick a random member who hasn't been suggested yet. Deduping
    // by contact means a person who's in many groups doesn't hog every slot, so
    // the lane spreads suggestions over as many different circles as possible.
    const out = [];
    const usedContacts = new Set();
    shuffle([...byGroup.keys()]).forEach((groupId) => {
      const members = shuffle(byGroup.get(groupId) || []);
      const pick = members.find(
        (p) => !usedContacts.has(p.contact?.normalized),
      );
      if (!pick) return; // everyone in this group is already suggested elsewhere
      usedContacts.add(pick.contact?.normalized);
      const group = pick.groups?.find((g) => g.id === groupId);
      out.push({ profile: pick, group });
    });
    return out.slice(0, 10);
  }, [analysis]);

  // The people the user hand-picked to stay close to ("Want to connect" group),
  // most overdue first. This is what feeds the spotlight when there's nothing
  // pressing in "reconnect today" — so the energetic card is never empty.
  const wantToConnect = useMemo(() => {
    const list = (analysis?.profiles || []).filter(
      (p) =>
        !p.remindersSuppressed &&
        (p.groups || []).some((g) => g.id === WANT_TO_CONNECT_GROUP_ID),
    );
    const overdue = (p) => {
      const d = p.summary?.daysSinceLast;
      return d === null || d === undefined ? Infinity : d;
    };
    return [...list].sort((a, b) => overdue(b) - overdue(a)).slice(0, 10);
  }, [analysis]);

  const reconnectToday = useMemo(
    () => analysis?.reconnectToday || [],
    [analysis],
  );

  // "Missed connections" usually leads the carousel (it yields to an empty
  // "Reconnect today" — see the cards builder below). iOS hides it when empty
  // (no call history to derive it) unless "show hidden cards" is on; Android
  // always includes it.
  const missedConnections = useMemo(
    () => analysis?.missedCallsToReturn || [],
    [analysis],
  );
  const includeMissed =
    missedConnections.length > 0 || Platform.OS === 'android' || showHidden;

  // Too little call history for the reconnect lane to be meaningful (a fresh
  // install, or iOS before any calls have been tracked). Needs at least a few
  // connected people. Gates the Reconnect card: when there's no reconnect data
  // and not enough history, the card is hidden entirely (rather than nudging
  // for a lane that can't work yet). It also picks the empty-state copy when the
  // card does show (e.g. under "show hidden cards").
  const notEnoughData = (analysis?.counts?.connectedPeople || 0) < 3;

  // The spotlight carousel, one card per lane. Order, left → right:
  //   • Missed connections — people who called and you haven't called back
  //   • Reconnect today     — the people the engine flags as overdue
  //   • Want to connect      — the people you hand-picked to keep close
  //   • Say hi today         — one light suggestion per group
  // Missed normally leads with Reconnect today centred to its right — but when
  // Reconnect today has no people to show (just its nudge / empty state) it
  // moves ahead of Missed, so the empty card isn't buried behind a populated
  // lane. This is ordering only: focusIndex (key-based) keeps the same card
  // centred either way. Each lane is its own swipeable card; empty lanes are
  // dropped (Missed follows the iOS hide-when-empty rule above).
  const cards = useMemo(() => {
    const out = [];
    const missedCard = includeMissed
      ? {
          key: 'missed',
          variant: 'accent',
          color: theme.colors.accent,
          kicker: 'MISSED CONNECTIONS',
          kickerIcon: 'phone-missed',
          subline: "They called — you haven't called back",
          list: missedConnections,
          footerLabel:
            missedConnections.length > 1
              ? `+${missedConnections.length - 1} more`
              : null,
          navTarget: 'ConnectMissed',
          emptyTitle: 'No missed connections',
          emptyBody: "You've returned everyone's calls.",
        }
      : null;
    // Show Reconnect when there's someone to reconnect with, or "show hidden
    // cards" is on. With no reconnect data, only show it once there's enough
    // call history to be meaningful (≥3 connected people, i.e. !notEnoughData);
    // a brand-new user with too little data sees nothing here rather than a
    // nudge for a lane that can't work yet.
    const reconnectCard =
      reconnectToday.length || showHidden || !notEnoughData
        ? { 
            key: 'reconnect',
            variant: 'primary',
            color: theme.colors.primary,
            kicker: 'RECONNECT TODAY',
            kickerIcon: 'lightning-bolt',
            subline: "You've gone quiet — a good time to reconnect",
            list: reconnectToday,
            footerLabel: reconnectToday.length > 1 ? 'See all' : null,
            navTarget: 'ConnectReconnect',
            emptyTitle: notEnoughData ? 'Start building your history' : 'All caught up',
            emptyBody: notEnoughData
              ? 'Connect finds people to reconnect with from your call history. Make a few calls and they’ll start showing up here.'
              : "People you've called before but haven't spoken to in a while show up here to reconnect. You're in touch with everyone right now.",
          }
        : null;
    // Reconnect leads only when it's present but empty; otherwise Missed leads.
    if (reconnectCard && reconnectToday.length === 0) {
      out.push(reconnectCard);
      if (missedCard) out.push(missedCard);
    } else {
      if (missedCard) out.push(missedCard);
      if (reconnectCard) out.push(reconnectCard);
    }
    if (wantToConnect.length || showHidden) {
      out.push({
        key: 'want',
        variant: 'primary',
        color: theme.colors.success,
        kicker: 'WANT TO CONNECT',
        kickerIcon: 'account-heart',
        subline: 'People you chose to keep close',
        list: wantToConnect,
        footerLabel: wantToConnect.length > 1 ? 'See all' : null,
        navTarget: 'ConnectGroupDetail',
        navParams: { groupId: WANT_TO_CONNECT_GROUP_ID },
        emptyTitle: 'No one picked yet',
        emptyBody: "Add people to your “Want to connect” group to see them here.",
      });
    }
    const randomProfiles = randomPerGroup.map((r) => r.profile);
    if (randomProfiles.length || showHidden) {
      out.push({
        key: 'random',
        variant: 'primary',
        color: theme.colors.warning,
        kicker: 'SAY HI TODAY',
        kickerIcon: 'hand-wave',
        subline: 'A few people from your circles',
        list: randomProfiles,
        footerLabel: null,
        emptyTitle: 'No suggestions yet',
        emptyBody: 'Sort some contacts into groups to get suggestions here.',
      });
    }
    return out;
  }, [
    includeMissed,
    missedConnections,
    reconnectToday,
    wantToConnect,
    randomPerGroup,
    showHidden,
    notEnoughData,
  ]);

  // The card the carousel opens on: "Reconnect today" if the engine flagged
  // anyone, otherwise "Want to connect", otherwise "Say hi today". Missed sits
  // beside it (to its left when Reconnect has people, to its right when
  // Reconnect is empty), reachable with a swipe.
  const focusIndex = useMemo(() => {
    // Prefer the first priority lane that actually has someone in it, so we
    // never open on an empty card (e.g. the low-data Reconnect nudge) while a
    // populated lane is sitting right beside it.
    for (const key of ['reconnect', 'want', 'random']) {
      const i = cards.findIndex((c) => c.key === key && c.list.length);
      if (i >= 0) return i;
    }
    // Nothing populated — fall back to the first priority lane present at all.
    for (const key of ['reconnect', 'want', 'random']) {
      const i = cards.findIndex((c) => c.key === key);
      if (i >= 0) return i;
    }
    return 0;
  }, [cards]);

  // Re-centre the carousel on the focus card only when the *set* of lanes
  // changes (signature), not on every focus-sync — so a manual swipe isn't
  // yanked back when the engine re-syncs.
  const signature = cards.map((c) => c.key).join(',');
  const carouselRef = useRef(null);
  useEffect(() => {
    if (!cards.length) return undefined;
    const x = focusIndex * (CARD_W + CARD_GAP);
    const raf = requestAnimationFrame(() => {
      carouselRef.current?.scrollTo({ x, animated: false });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, CARD_W]);

  const onCardPress = useCallback(
    (profile) => {
      navigation.navigate('ConnectContactDetail', {
        phone: profile.contact.normalized,
      });
    },
    [navigation],
  );

  const onCall = useCallback((profile) => {
    const phone = profile?.contact?.phone;
    if (!phone) return;
    // Records a provisional reconnect, then the call monitor reconciles it with
    // what actually happened (real duration, or removed if it never connected).
    initiateTrackedCall(phone).catch(() => {});
  }, []);

  return (
    <View style={styles.container}>
      <AppHeader
        title="Connect"
        subtitle="Who should you reach out to today?"
        rightElement={
          <View style={styles.headerRightWrap}>
            <TouchableOpacity
              onPress={() => setOverflowOpen(true)}
              style={styles.overflowBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Icon name="dots-vertical" size={22} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
        }
      />
      <ConnectSetupGate>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.primary}
          />
        }
        contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
      >
        {/* Slot machine: a playful "who should I call?" roller that sits above
            the lanes. Spins up to five people, one per random circle, and
            shares the cards' dismissal counter (re-spin = soft dismiss). */}
        <SlotMachine
          profiles={analysis?.profiles || []}
          totalContacts={analysis?.counts?.total || 0}
          onCall={onCall}
          onOpenContact={onCardPress}
        />

        {/* The magnetic centrepiece: a swipeable carousel with one spotlight
            card per lane — Missed connections, Reconnect today, Want to connect,
            Say hi today. It opens centred on the focus card; the next card peeks
            ~10% to hint the swipe; the "up next" queue below follows whichever
            card is centred. */}
        {cards.length ? (
            <ScrollView
              ref={carouselRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              decelerationRate="fast"
              snapToInterval={CARD_W + CARD_GAP}
              snapToAlignment="start"
              contentOffset={{ x: focusIndex * (CARD_W + CARD_GAP), y: 0 }}
              contentContainerStyle={styles.carousel}
            >
              {cards.map((card, idx) => (
                <View
                  key={card.key}
                  style={{
                    width: CARD_W,
                    marginRight: idx < cards.length - 1 ? CARD_GAP : 0,
                  }}
                >
                  <SpotlightCard
                    profile={card.list[0] || null}
                    width={CARD_W}
                    variant={card.variant}
                    color={card.color}
                    kicker={card.kicker}
                    kickerIcon={card.kickerIcon}
                    subline={card.subline}
                    footerLabel={card.footerLabel}
                    onFooterPress={
                      card.navTarget
                        ? () =>
                            navigation.navigate(card.navTarget, card.navParams)
                        : undefined
                    }
                    emptyTitle={card.emptyTitle}
                    emptyBody={card.emptyBody}
                    onPress={onCardPress}
                    onCall={onCall}
                  />
                </View>
              ))}
            </ScrollView>
        ) : (
          <EmptyState
            icon="account-heart-outline"
            title="Add people to stay close to"
            body="Pick a few people for your “Want to connect” group and they’ll show up here."
          />
        )}

        {milestones.length > 0 ? (
          <>
            <SectionHeader
              title="Milestones"
              caption="Rack up wins as you keep your circle warm"
            />
            <MilestonesCard milestones={milestones} />
          </>
        ) : null}

        {(analysis?.recentlyReconnected || []).length > 0 ? (
          <>
            <SectionHeader
              title="Recently reconnected"
              caption="The momentum you have already built"
            />
            {(analysis?.recentlyReconnected || []).slice(0, 5).map((p) => (
              <ReconnectCard
                key={`r_${p.contact.normalized}`}
                profile={p}
                compact
                onPress={() => onCardPress(p)}
              />
            ))}
          </>
        ) : null}

      </ScrollView>
      </ConnectSetupGate>

      <Modal
        visible={overflowOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setOverflowOpen(false)}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={styles.overflowBackdrop}
          onPress={() => setOverflowOpen(false)}
        >
          <View style={styles.overflowCard}>
            <TouchableOpacity
              style={styles.overflowRow}
              onPress={() => {
                // Close the overflow menu first, then open the native share
                // sheet once the Modal has finished dismissing. Invoking
                // Share.share() while the Modal is still on screen makes the
                // share sheet present over (or get cancelled by) the dismissing
                // modal — which is why this silently did nothing here while the
                // identical button on the Settings screen (no modal) worked.
                setOverflowOpen(false);
                setTimeout(shareApp, 300);
              }}
            >
              <Icon name="share-variant-outline" size={18} color={theme.colors.primary} />
              <Text style={styles.overflowText}>Share Connect</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.overflowRow}
              onPress={() => {
                // Close the overflow menu, then open the About modal once the
                // menu Modal has finished dismissing (same presentation
                // ordering as Share, above).
                setOverflowOpen(false);
                setTimeout(() => setAboutOpen(true), 300);
              }}
            >
              <Icon name="information-outline" size={18} color={theme.colors.primary} />
              <Text style={styles.overflowText}>About</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <AboutModal visible={aboutOpen} onClose={() => setAboutOpen(false)} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  carousel: {
    paddingLeft: theme.spacing.lg,
    paddingRight: theme.spacing.lg,
    paddingTop: theme.spacing.md,
  },
  headerRightWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  overflowBtn: {
    paddingHorizontal: 4,
    marginRight: theme.spacing.xs,
  },
  loginBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface,
  },
  loginBtnText: {
    marginLeft: 4,
    color: theme.colors.primary,
    fontWeight: '600',
    fontSize: theme.font.small,
  },
  overflowBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  overflowCard: {
    position: 'absolute',
    top: 80,
    right: theme.spacing.lg,
    minWidth: 240,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing.xs,
  },
  overflowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  overflowText: {
    marginLeft: theme.spacing.md,
    fontSize: theme.font.body,
    color: theme.colors.text,
  },
});

export default HomeScreen;
