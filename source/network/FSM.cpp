/* Copyright (C) 2024 Wildfire Games.
 * This file is part of 0 A.D.
 *
 * 0 A.D. is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * 0 A.D. is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with 0 A.D.  If not, see <http://www.gnu.org/licenses/>.
 */

#include "precompiled.h"
#include "FSM.h"


CFsmEvent::CFsmEvent(unsigned int type, void* pParam)
{
	m_Type = type;
	m_Param = pParam;
}

CFsmEvent::~CFsmEvent()
{
	m_Param = nullptr;
}

void CFsm::AddTransition(unsigned int state, unsigned int eventType, unsigned int nextState,
	Action* pAction /* = nullptr */, void* pContext /* = nullptr*/)
{
	m_Transitions.insert({TransitionKey{state, eventType}, Transition{{pAction, pContext}, nextState}});
}

void CFsm::SetFirstState(unsigned int firstState)
{
	m_FirstState = firstState;
}

void CFsm::SetCurrState(unsigned int state)
{
	m_CurrState = state;
}

bool CFsm::IsFirstTime() const
{
	return (m_CurrState == FSM_INVALID_STATE);
}

bool CFsm::Update(unsigned int eventType, void* pEventParam)
{
	if (IsFirstTime())
		m_CurrState = m_FirstState;

	// Lookup transition
	auto transitionIterator = m_Transitions.find({m_CurrState, eventType});
	if (transitionIterator == m_Transitions.end())
		return false;

	CFsmEvent event{eventType, pEventParam};

	// Save the default state transition (actions might call SetNextState
	// to override this)
	SetNextState(transitionIterator->second.nextState);

	if (!transitionIterator->second.action(event))
		return false;

	SetCurrState(GetNextState());

	// Reset the next state since it's no longer valid
	SetNextState(FSM_INVALID_STATE);

	return true;
}

bool CFsm::IsDone() const
{
	return m_Done;
}
