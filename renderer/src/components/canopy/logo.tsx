// The Canopy mark. Uses currentColor, so it takes the text color it sits in.
const PATHS = [
  'M610 383H928Q942 383 940 368C925 300 860 256 785 256H750C676 256 612 300 598 368Q596 383 610 383Z',
  'M510 552H548Q556 552 562 546C580 528 605 515 638 515H898C931 515 956 528 974 546Q980 552 988 552H1028Q1040 552 1040 540C1040 470 975 411 902 411H634C561 411 497 470 497 540Q497 552 510 552Z',
  'M571 632H704C725 632 741 648 741 670V740Q741 751 752 751H784Q795 751 795 740V670C795 648 811 632 833 632H962Q977 632 976 616C970 575 932 542 897 542H640C602 542 565 575 559 616Q557 632 571 632Z',
];

export function Logo({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="468 203 600 600" className={className} style={style} aria-label="Canopy" fill="currentColor">
      {/* data-tier: 0 is the top of the canopy, 2 the bottom tier with the trunk (hover animations move them apart). */}
      {PATHS.map((d, i) => <path key={d} d={d} data-tier={i} />)}
    </svg>
  );
}
