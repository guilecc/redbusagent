/**
 * @redbusagent/tui — Entry Point
 *
 * Bootstraps the Ink (React for terminals) application,
 * rendering the Dashboard as the root component.
 */

import React from 'react';
import { render } from 'ink';
import { Dashboard } from './components/Dashboard.js';

render(React.createElement(Dashboard));
